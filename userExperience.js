(function expose(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PicGenUX = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function explainError(entry = {}) {
        const text = `${entry.code || ''} ${entry.message || entry.error || ''} ${entry.phase || ''}`;
        const status = Number(entry.httpStatus || entry.status) || Number(text.match(/\b(4\d\d|5\d\d)\b/)?.[1]);
        if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT_|ERR_CERT/i.test(text))
            return { title: '结果图下载被假证书拦住', advice: '图片已经生成，但下载地址的证书不是正规证书，多半是本机 DNS 或安全软件劫持。换 DNS（如 223.5.5.5）或暂时退出拦截软件后再试；不要关闭证书校验。', action: 'network' };
        if (/OUTCOME_UNCERTAIN|outcome-uncertain|RESULT_DOWNLOAD_FAILED|结果.*不确定|已在供应商生成|轮询超时/i.test(text))
            return { title: '生成结果尚未确认', advice: '供应商可能已经生成并计费。请先到供应商后台核对任务，再决定是否重新生成。', action: 'logs' };
        if (/quota|balance|credit|insufficient|余额|额度不足/i.test(text) || status === 402)
            return { title: '供应商额度不足', advice: '请检查供应商余额和模型额度，或选择其他可用供应商。', action: 'provider' };
        if ([401, 403].includes(status) || /invalid.*key|unauthorized|鉴权/i.test(text))
            return { title: '供应商拒绝了访问', advice: '请检查 API Key 是否有效，以及账号是否有该模型的使用权限。', action: 'provider' };
        if (status === 429)
            return { title: '请求过于频繁', advice: '供应商暂时限制了请求数量。请稍后再试，或降低该配置组的并发数。', action: 'concurrency' };
        if (/ENOSPC|磁盘.*满/i.test(text))
            return { title: '磁盘空间不足', advice: '请释放磁盘空间，或选择其他图片保存目录。', action: 'output' };
        if (/ENOENT|EACCES|EPERM|文件不存在|无法读取/i.test(text) || entry.source === 'storage')
            return { title: '图片或保存目录无法访问', advice: '请确认文件没有被移动、磁盘已连接，并检查保存目录的写入权限。', action: 'output' };
        if (/ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|fetch failed|network|网络|连接失败/i.test(text))
            return { title: '连接供应商失败', advice: '请检查网络和代理设置；确认供应商地址正确后再试。', action: 'network' };
        if (status >= 500 || /timeout|超时/i.test(text))
            return { title: '供应商响应异常或超时', advice: '请稍后再试或更换供应商；若任务已经提交，请先核对供应商记录，避免重复生成。', action: 'provider' };
        if ([400, 404, 422].includes(status) || /unsupported|not support|不支持|模型/i.test(text))
            return { title: '模型或生成参数不匹配', advice: '请检查模型名称、请求格式、图片数量和尺寸是否受供应商支持。', action: 'provider' };
        return { title: '本次操作未完成', advice: '请展开技术详情查看原因。问题持续时，可复制诊断信息交给维护人员。', action: 'logs' };
    }

    // One key per history record, shared by main (similarity service) and the renderer.
    function historyKey(record) {
        return String(record?.id || record?.filePath || record?.fileName || '');
    }

    function reorderReferences(references, sourceId, targetId, after = false) {
        const source = references.findIndex(ref => ref.id === sourceId);
        if (source < 0 || sourceId === targetId || !references.some(ref => ref.id === targetId)) return references;
        const next = references.slice();
        const [reference] = next.splice(source, 1);
        next.splice(next.findIndex(ref => ref.id === targetId) + Number(after), 0, reference);
        return next;
    }
    return { explainError, historyKey, reorderReferences };
});
