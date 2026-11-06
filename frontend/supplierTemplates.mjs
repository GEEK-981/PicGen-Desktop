// Ready-made suppliers for the "新增供应商" form: address, image models and their
// request formats are filled in, so a new user only pastes an API key. The model
// lists and protocols mirror groups verified to work against these relays.
// signupUrl is where the form's "注册获取 Key" link points.

export const SUPPLIER_TEMPLATES = [
    {
        id: 'zivv',
        label: 'Zivv',
        badge: '推荐',
        name: 'Zivv',
        website: 'https://zivv.pro',
        baseUrl: 'https://zivv.pro',
        signupUrl: 'https://zivv.pro/register?invite=7b6bfcde',
        icon: 'zap',
        group: {
            name: '生图',
            maxConcurrent: 10,
            models: ['gemini-3.1-flash-image', 'nano-banana-pro', 'gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'],
            modelRouting: {}
        }
    },
    {
        id: 'xuedingmao',
        label: '薛定猫',
        badge: '推荐',
        name: '薛定猫',
        website: 'https://yunzhicode.com',
        baseUrl: 'https://yunzhicode.com',
        signupUrl: 'https://yunzhicode.com/sign-up?aff=1t2l',
        icon: 'atom',
        group: {
            name: '生图',
            maxConcurrent: 10,
            models: ['gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.6-sunburst'],
            // This relay serves Gemini models through the native Gemini endpoint.
            modelRouting: {
                'gemini-3.1-flash-image-preview': { protocol: 'gemini-native' },
                'gemini-3-pro-image-preview': { protocol: 'gemini-native' },
                'gpt-image-2': { protocol: 'openai-images' },
                'gpt-image-2.5-sunburst': { protocol: 'openai-images' },
                'gpt-image-2.5-flare': { protocol: 'openai-images' }
            }
        }
    }
];

export function findSupplierTemplate(id) {
    return SUPPLIER_TEMPLATES.find(template => template.id === id) || null;
}
