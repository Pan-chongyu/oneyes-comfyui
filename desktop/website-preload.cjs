const { ipcRenderer } = require('electron');

if (process.isMainFrame && location.origin === 'https://oneyes.ai') {
    let sent;
    const timer = setInterval(() => {
        const access_token = localStorage.getItem('auth_token'), refresh_token = localStorage.getItem('refresh_token');
        if (!access_token || !refresh_token || sent === access_token) return;
        sent = access_token;
        void ipcRenderer.invoke('oneyes:website-session', { access_token, refresh_token }).catch(() => { sent = undefined; });
    }, 500);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
