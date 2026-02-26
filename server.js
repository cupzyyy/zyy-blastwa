const express = require('express');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const config = require('./config');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ======================== STATE VARIABLES ====================
let Angkasa = null;
let waConnectionStatus = 'closed';
let pairingCodeRequested = false;
let currentPairingCode = null;
let connectedPhoneNumber = null;
let connectionLogs = [];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    const logEntry = { message, type, timestamp };
    connectionLogs.push(logEntry);
    // Keep only last 50 logs
    if (connectionLogs.length > 50) connectionLogs.shift();
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
}

// ======================== FUNCTION CONNECT ====================

async function startWhatsAppClient(phoneNumber = null) {
    addLog("Mencoba memulai koneksi WhatsApp...", "info");

    const { state, saveCreds } = await useMultiFileAuthState(config.sessionName);
    const { version } = await fetchLatestBaileysVersion();

    addLog(`Baileys version: ${version.join('.')}`, "info");

    const connectionOptions = {
        version,
        keepAliveIntervalMs: 30000,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        browser: ["Mac OS", "Safari", "10.15.7"],
        getMessage: async (key) => ({
            conversation: 'P',
        }),
    };

    Angkasa = makeWASocket(connectionOptions);

    // Request pairing code if phone number provided and not registered
    if (phoneNumber && !Angkasa.authState.creds.registered) {
        await delay(2000);
        try {
            // Format phone number (remove +, spaces, dashes)
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            addLog(`Meminta pairing code untuk nomor: ${cleanNumber}`, "info");
            
            const code = await Angkasa.requestPairingCode(cleanNumber);
            currentPairingCode = code;
            pairingCodeRequested = true;
            addLog(`Pairing code berhasil didapat: ${code}`, "success");
        } catch (err) {
            addLog(`Gagal mendapatkan pairing code: ${err.message}`, "error");
            currentPairingCode = null;
            pairingCodeRequested = false;
        }
    }

    Angkasa.ev.on('creds.update', saveCreds);

    Angkasa.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection) {
            waConnectionStatus = connection;
            addLog(`Status koneksi WA: ${connection}`, "info");
        }

        if (connection === 'open') {
            const user = Angkasa.user;
            connectedPhoneNumber = user?.id?.split(':')[0] || 'Unknown';
            currentPairingCode = null;
            pairingCodeRequested = false;
            
            addLog('✅ WHATSAPP BERHASIL TERHUBUNG!', "success");
            addLog(`Terhubung sebagai: ${user?.name || connectedPhoneNumber}`, "success");
            
            console.log(chalk.green.bold(`
╭─────────────────────────────────
┃ ✅ WHATSAPP CONNECTED
┃ User: ${user?.name || 'N/A'}
┃ Number: ${connectedPhoneNumber}
╰─────────────────────────────────`));
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            connectedPhoneNumber = null;

            console.log(chalk.red.bold(`
╭─────────────────────────────────
┃ ❌ WHATSAPP DISCONNECTED
┃ Status Code: ${statusCode}
╰─────────────────────────────────`));

            if (shouldReconnect) {
                addLog('Koneksi terputus. Mencoba reconnect dalam 5 detik...', "warning");
                setTimeout(() => startWhatsAppClient(), 5000);
            } else {
                addLog('Logged out. Tidak bisa menyambung ulang. Silakan pairing ulang.', "error");
                Angkasa = null;
                currentPairingCode = null;
                pairingCodeRequested = false;
            }
        }
    });

    Angkasa.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const sender = msg.key.remoteJid;
        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || '';
        
        if (text) {
            addLog(`📩 Pesan dari ${sender}: ${text.substring(0, 50)}...`, "info");
        }
    });
}

// ======================== API ROUTES ====================

// Get connection status
app.get('/api/status', (req, res) => {
    res.json({
        status: waConnectionStatus,
        pairingCode: currentPairingCode,
        pairingCodeRequested: pairingCodeRequested,
        connectedNumber: connectedPhoneNumber,
        isConnected: waConnectionStatus === 'open',
        logs: connectionLogs.slice(-20)
    });
});

// Request pairing code
app.post('/api/pair', async (req, res) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nomor telepon harus diisi!' 
        });
    }

    if (waConnectionStatus === 'open') {
        return res.status(400).json({ 
            success: false, 
            message: 'WhatsApp sudah terhubung!' 
        });
    }

    try {
        // Reset state
        currentPairingCode = null;
        pairingCodeRequested = false;
        waConnectionStatus = 'connecting';
        
        addLog(`Memulai proses pairing untuk nomor: ${phoneNumber}`, "info");
        
        // Start WhatsApp client with phone number
        await startWhatsAppClient(phoneNumber);

        // Wait for pairing code (max 15 seconds)
        let attempts = 0;
        while (!currentPairingCode && attempts < 30) {
            await delay(500);
            attempts++;
        }

        if (currentPairingCode) {
            res.json({
                success: true,
                pairingCode: currentPairingCode,
                message: 'Pairing code berhasil dibuat! Masukkan kode di WhatsApp kamu.'
            });
        } else {
            res.status(408).json({
                success: false,
                message: 'Timeout. Gagal mendapatkan pairing code. Coba lagi.'
            });
        }
    } catch (error) {
        addLog(`Error: ${error.message}`, "error");
        res.status(500).json({
            success: false,
            message: `Error: ${error.message}`
        });
    }
});

// Disconnect WhatsApp
app.post('/api/disconnect', async (req, res) => {
    try {
        if (Angkasa) {
            await Angkasa.logout();
            Angkasa = null;
        }
        waConnectionStatus = 'closed';
        currentPairingCode = null;
        pairingCodeRequested = false;
        connectedPhoneNumber = null;
        
        // Delete session files
        const fs = require('fs');
        if (fs.existsSync(config.sessionName)) {
            fs.rmSync(config.sessionName, { recursive: true, force: true });
            addLog('Session files dihapus.', "info");
        }

        addLog('WhatsApp berhasil di-disconnect.', "warning");
        res.json({ success: true, message: 'Berhasil disconnect dari WhatsApp.' });
    } catch (error) {
        addLog(`Error disconnect: ${error.message}`, "error");
        res.status(500).json({ success: false, message: error.message });
    }
});

// Send message (bonus feature)
app.post('/api/send', async (req, res) => {
    const { number, message } = req.body;

    if (!Angkasa || waConnectionStatus !== 'open') {
        return res.status(400).json({ 
            success: false, 
            message: 'WhatsApp belum terhubung!' 
        });
    }

    if (!number || !message) {
        return res.status(400).json({ 
            success: false, 
            message: 'Nomor dan pesan harus diisi!' 
        });
    }

    try {
        const cleanNumber = number.replace(/[^0-9]/g, '');
        const jid = cleanNumber + '@s.whatsapp.net';
        
        await Angkasa.sendMessage(jid, { text: message });
        addLog(`📤 Pesan terkirim ke ${cleanNumber}: ${message.substring(0, 50)}`, "success");
        
        res.json({ success: true, message: 'Pesan berhasil dikirim!' });
    } catch (error) {
        addLog(`Gagal kirim pesan: ${error.message}`, "error");
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get logs
app.get('/api/logs', (req, res) => {
    res.json({ logs: connectionLogs.slice(-30) });
});

// ======================== START SERVER ====================

app.listen(config.port, () => {
    console.log(chalk.cyan.bold(`
╭══════════════════════════════════════════╮
║                                          ║
║   🚀 WhatsApp Pairing Code Server       ║
║   📡 Running on http://localhost:${config.port}    ║
║                                          ║
║   Buka browser dan akses URL di atas     ║
║                                          ║
╰══════════════════════════════════════════╯
    `));

    // Try to auto-connect if session exists
    const fs = require('fs');
    if (fs.existsSync(config.sessionName + '/creds.json')) {
        addLog('Session ditemukan. Auto-connecting...', "info");
        startWhatsAppClient();
    }
});