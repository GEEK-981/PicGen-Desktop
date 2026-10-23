import React, { useState, useLayoutEffect } from 'react';
import { Button } from '@appica/ui-react/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@appica/ui-react/dialog';

let showDialog;
const pending = [];
export function confirmAction(message, options = {}) {
  return new Promise(resolve => {
    pending.push({ message, options, resolve });
    showDialog?.();
  });
}

export function ConfirmDialog() {
  const [request, setRequest] = useState(null);
  useLayoutEffect(() => {
    showDialog = () => setRequest(current => current || pending[0] || null);
    showDialog();
    return () => { showDialog = null; };
  }, []);
  const finish = result => {
    if (!request) return;
    pending.shift();
    request.resolve(result);
    setRequest(pending[0] || null);
  };
  return <>
    <div id="confirmOverlay" hidden={!request} data-appica-dialog-state={request ? 'open' : 'closed'} />
    <Dialog open={!!request} onOpenChange={open => { if (!open) finish(false); }}>
      <DialogContent className="picgen-confirm" closeButton={false} frame={false}>
        <DialogHeader>
          <DialogTitle id="confirmTitle">{request?.options.title || '确认操作'}</DialogTitle>
          <DialogDescription id="confirmMessage">{request?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button id="confirmCancelBtn" variant="outline" size="sm" onClick={() => finish(false)}>取消</Button>
          <Button id="confirmOkBtn" variant={request?.options.danger ? 'destructive' : 'primary'}
            size="sm" onClick={() => finish(true)}>{request?.options.okText || '确定'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
