const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const P = require('pino');

// Simpen session sementara di memory (akan ilang kalo function cold start)
const sessions = new Map();

module.exports = async (req, res) => {
    // Set CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // GET: cek status
    if (req.method === 'GET') {
        const { phone } = req.query;
        const session = sessions.get(phone);
        return res.json({
            status: session?.status || 'not_found',
            pairingCode: session?.pairingCode || null
        });
    }
    
    // POST: request pairing code
    if (req.method === 'POST') {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber || !phoneNumber.match(/^62[0-9]{9,13}$/)) {
            return res.status(400).json({ error: 'Format nomor salah! Contoh: 6281234567890' });
        }
        
        // Cek session existing
        if (sessions.has(phoneNumber)) {
            const existing = sessions.get(phoneNumber);
            if (existing.status === 'connected') {
                return res.json({ success: true, status: 'connected', message: 'Sudah terhubung!' });
            }
            if (existing.pairingCode) {
                return res.json({ 
                    success: true, 
                    status: 'waiting', 
                    pairingCode: existing.pairingCode,
                    message: 'Kode pairing masih aktif'
                });
            }
        }
        
        // Mulai pairing (tanpa await biar gak timeout)
        startPairingAsync(phoneNumber);
        
        // Langsung balik response dulu (soalnya pairing butuh waktu)
        return res.json({ 
            success: true, 
            status: 'processing',
            message: 'Sedang memproses pairing code, cek status GET /api/pair?phone=' + phoneNumber 
        });
    }
    
    res.status(405).json({ error: 'Method not allowed' });
};

// Async pairing process (jalan di background, tapi inget Vercel bakal kill setelah response)
async function startPairingAsync(phoneNumber) {
    console.log(`[${phoneNumber}] Starting pairing...`);
    
    // Buat session di memory dulu
    sessions.set(phoneNumber, { status: 'pairing', pairingCode: null, createdAt: Date.now() });
    
    try {
        // Di Vercel kita gak bisa nyimpen file permanent, jadi pake in-memory session
        // Tapi Baileys butuh file, jadi kita pake temporary path
        const { writeFileSync, mkdtempSync, rmSync } = require('fs');
        const { join } = require('path');
        const { tmpdir } = require('os');
        
        const tempDir = mkdtempSync(join(tmpdir(), 'wa-session-'));
        
        const { state, saveCreds } = await useMultiFileAuthState(tempDir);
        
        let version;
        try {
            const v = await fetchLatestBaileysVersion();
            version = v.version;
        } catch(e) {
            version = [2, 3000, 1015901307];
        }
        
        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: P({ level: 'silent' }),
            browser: ['Chrome', 'Windows', '120.0.0.0'],
            markOnlineOnConnect: false,
            connectTimeoutMs: 30000
        });
        
        // Request pairing code
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                
                const session = sessions.get(phoneNumber);
                if (session) {
                    session.pairingCode = formatted;
                    session.status = 'waiting';
                    sessions.set(phoneNumber, session);
                }
                console.log(`[${phoneNumber}] Pairing code: ${formatted}`);
            } catch(err) {
                console.error(`[${phoneNumber}] Pairing error:`, err.message);
                const session = sessions.get(phoneNumber);
                if (session) {
                    session.status = 'error';
                    session.error = err.message;
                    sessions.set(phoneNumber, session);
                }
            }
        }, 2000);
        
        // Monitor connection
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            const session = sessions.get(phoneNumber);
            
            if (connection === 'open') {
                console.log(`[${phoneNumber}] ✅ Connected!`);
                if (session) {
                    session.status = 'connected';
                    session.connectedAt = Date.now();
                    session.pairingCode = null;
                    sessions.set(phoneNumber, session);
                }
                // Cleanup temp dir setelah connected
                setTimeout(() => {
                    try { rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
                }, 5000);
            }
            else if (connection === 'close') {
                console.log(`[${phoneNumber}] Connection closed`);
                // Hapus session setelah 1 menit kalo disconnect
                setTimeout(() => {
                    if (sessions.get(phoneNumber)?.status !== 'connected') {
                        sessions.delete(phoneNumber);
                    }
                }, 60000);
            }
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Auto cleanup temp dir setelah 1 menit
        setTimeout(() => {
            try { rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}
        }, 60000);
        
    } catch(err) {
        console.error(`[${phoneNumber}] Fatal error:`, err);
        sessions.set(phoneNumber, { status: 'error', error: err.message });
    }
          }
