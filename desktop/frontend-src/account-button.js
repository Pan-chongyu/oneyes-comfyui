import { h, openSettings } from '/oneyes-native.js';

export default {
    name: 'OneYesAccountButton',
    data: () => ({ account: null, unsubscribe: null, failedAvatar: '' }),
    mounted() {
        if (!document.querySelector('link[data-oneyes-account-button]')) {
            const style = document.createElement('link');
            style.rel = 'stylesheet';
            style.href = new URL('oneyes-account-button.css', import.meta.url).href;
            style.dataset.oneyesAccountButton = 'true';
            document.head.append(style);
        }
        const update = state => {
            if (this.account?.user?.id !== state.account?.user?.id || this.account?.user?.avatar_url !== state.account?.user?.avatar_url) this.failedAvatar = '';
            this.account = state.account;
        };
        this.unsubscribe = window.oneYesDesktop.onState(update);
        window.oneYesDesktop.state().then(update).catch(() => {});
    },
    beforeUnmount() { this.unsubscribe?.(); },
    render() {
        const user = this.account?.user;
        const avatar = user?.avatar_url;
        const name = user?.username || user?.email || '';
        const connected = Boolean(this.account?.connected);
        const title = user ? `OneYes · ${name} · ${connected ? '余额 $' + Number(user.balance || 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : '暂未连接，点击重连'}` : '登录 OneYes，使用云端模型';
        return h('button', {
            type: 'button', class: 'oneyes-account-button',
            'data-testid': 'oneyes-account-button',
            'data-connection': user ? connected ? 'connected' : 'offline' : 'signed-out',
            'aria-label': title, title,
            onClick: () => openSettings('account'),
        }, [
            h('span', { class: 'oneyes-account-avatar', 'aria-hidden': 'true' }, [
                h('i', { class: 'icon-[lucide--user] size-4' }),
                avatar && avatar !== this.failedAvatar ? h('img', { key: avatar, src: avatar, alt: '', referrerpolicy: 'no-referrer', onLoad: event => { event.target.dataset.loaded = 'true'; }, onError: () => { this.failedAvatar = avatar; } }) : null,
            ]),
            h('span', { class: 'oneyes-account-label' }, user ? `OneYes · ${name}` : 'OneYes 登录'),
        ]);
    },
};
