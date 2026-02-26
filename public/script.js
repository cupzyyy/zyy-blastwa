const socket = io();

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const userInfo = document.getElementById('userInfo');
const userName = document.getElementById('userName');
const userId = document.getElementById('userId');
const inputSection = document.getElementById('inputSection');
const pairingSection = document.getElementById('pairingSection');
const connectedSection = document.getElementById('connectedSection');
const phoneNumber = document.getElementById('phoneNumber');
const connectBtn = document.getElementById('connectBtn');
const pairingCode = document.getElementById('pairingCode');
const copyCodeBtn = document.getElementById('copyCodeBtn');
const cancelBtn = document.getElementById('cancelBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const timerElement = document.getElementById('timer');
const connectedName = document.getElementById('connectedName');
const connectedId = document.getElementById('connectedId');

// Variables
let timerInterval;
let timeLeft = 60;

// Socket event listeners
socket.on('connect', () => {
    console.log('Terhubung ke server');
});

socket.on('connection-status', (status) => {
    updateConnectionStatus(status);
});

socket.on('pairing-code', (code) => {
    showPairingCode(code);
    startTimer();
});

socket.on('connected', (data) => {
    showConnected(data);
});

socket.on('logged-out', () => {
    resetToInitial();
    alert('Anda telah logout dari WhatsApp');
});

socket.on('error', (message) => {
    alert('Error: ' + message);
    resetToInitial();
});

// Update connection status
function updateConnectionStatus(status) {
    connectionStatus.textContent = status === 'open' ? 'Connected' : 
                                   status === 'connecting' ? 'Connecting' : 'Disconnected';
    connectionStatus.className = 'status-value ' + 
                                (status === 'open' ? 'connected' : 
                                 status === 'connecting' ? 'connecting' : 'disconnected');
}

// Show pairing code
function showPairingCode(code) {
    inputSection.style.display = 'none';
    pairingSection.style.display = 'block';
    connectedSection.style.display = 'none';
    
    pairingCode.textContent = code;
}

// Show connected
function showConnected(data) {
    inputSection.style.display = 'none';
    pairingSection.style.display = 'none';
    connectedSection.style.display = 'block';
    
    userInfo.style.display = 'block';
    userName.textContent = data.name;
    userId.textContent = data.id;
    
    connectedName.textContent = data.name;
    connectedId.textContent = data.id;
    
    clearInterval(timerInterval);
}

// Reset to initial state
function resetToInitial() {
    inputSection.style.display = 'block';
    pairingSection.style.display = 'none';
    connectedSection.style.display = 'none';
    userInfo.style.display = 'none';
    
    phoneNumber.value = '';
    connectBtn.disabled = false;
    connectBtn.querySelector('.btn-text').style.display = 'inline';
    connectBtn.querySelector('.loading-spinner').style.display = 'none';
    
    clearInterval(timerInterval);
}

// Start timer
function startTimer() {
    timeLeft = 60;
    timerElement.textContent = timeLeft;
    
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        timerElement.textContent = timeLeft;
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            if (pairingSection.style.display === 'block') {
                alert('Kode pairing telah kadaluarsa. Silakan coba lagi.');
                resetToInitial();
            }
        }
    }, 1000);
}

// Connect button click
connectBtn.addEventListener('click', async () => {
    const number = phoneNumber.value.trim();
    
    if (!number) {
        alert('Masukkan nomor telepon');
        return;
    }
    
    // Show loading
    connectBtn.disabled = true;
    connectBtn.querySelector('.btn-text').style.display = 'none';
    connectBtn.querySelector('.loading-spinner').style.display = 'inline-block';
    
    try {
        const response = await fetch('/api/connect', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ phoneNumber: number })
        });
        
        const data = await response.json();
        
        if (!data.success) {
            alert('Error: ' + data.error);
            resetToInitial();
        }
    } catch (error) {
        alert('Gagal menghubungkan ke server');
        resetToInitial();
    }
});

// Copy code button
copyCodeBtn.addEventListener('click', () => {
    const code = pairingCode.textContent;
    navigator.clipboard.writeText(code).then(() => {
        alert('Kode berhasil disalin!');
    }).catch(() => {
        alert('Gagal menyalin kode');
    });
});

// Cancel button
cancelBtn.addEventListener('click', async () => {
    if (confirm('Batalkan proses pairing?')) {
        try {
            await fetch('/api/logout', { method: 'POST' });
        } catch (error) {
            console.error('Error:', error);
        }
        resetToInitial();
    }
});

// Disconnect button
disconnectBtn.addEventListener('click', async () => {
    if (confirm('Putuskan koneksi WhatsApp?')) {
        try {
            await fetch('/api/logout', { method: 'POST' });
        } catch (error) {
            console.error('Error:', error);
        }
        resetToInitial();
    }
});

// Enter key on phone input
phoneNumber.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        connectBtn.click();
    }
});

// Get initial status
fetch('/api/status')
    .then(res => res.json())
    .then(data => {
        updateConnectionStatus(data.status);
    });