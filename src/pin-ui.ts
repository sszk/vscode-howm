// Filled adaptation of Microsoft Codicons (CC BY 4.0); see resources/codicons-LICENSE.
// Inline SVGs avoid loading a font or allowing additional webview CSP sources.
const pinIcon = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M10.0589 2.44511C9.34701 1.73063 8.14697 1.90829 7.67261 2.79839L5.6526 6.58878L2.8419 7.52568C2.6775 7.58048 2.5532 7.71649 2.51339 7.88514C2.47357 8.0538 2.52392 8.23104 2.64646 8.35357L4.79291 10.5L2.14645 13.1465L2 14L2.85356 13.8536L5.50002 11.2071L7.64646 13.3536C7.76899 13.4761 7.94623 13.5265 8.11489 13.4866C8.28354 13.4468 8.41955 13.3225 8.47435 13.1581L9.41143 10.3469L13.1897 8.32423C14.0759 7.84982 14.2538 6.6551 13.5443 5.94305L10.0589 2.44511Z"/></svg>';

export const pinStyles = `
.note-row{display:flex;align-items:center;width:100%;min-width:0;border-radius:2px}
.note-row:hover{background:var(--vscode-list-hoverBackground)}
.note-row>.note{flex:1;min-width:0;width:auto}
.pin{display:flex;align-items:center;justify-content:center;flex:0 0 24px;width:24px;height:24px;padding:4px;box-sizing:border-box;opacity:0;color:var(--vscode-icon-foreground);background:transparent;border:0;border-radius:2px;cursor:pointer}
.pin[aria-pressed="true"],.note-row:hover>.pin,.note-row:focus-within>.pin,.pin:focus-visible{opacity:1}
.pin[aria-pressed="true"]>svg{transform:rotate(45deg) scale(.85)}
.pin:hover{background:var(--vscode-toolbar-hoverBackground)}
.pin:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
`;

export function pinButton(id: string, pinned: boolean): string {
  const label = pinned ? "ピン留めを解除" : "メモをピン留め";
  return `<button class="pin" data-pin-id="${id}" aria-pressed="${pinned}" aria-label="${label}" title="${label}">${pinIcon}</button>`;
}

// Shared by the calendar and similar-notes webviews. Update only the buttons,
// retaining focus, scroll position, and the views' existing ordering.
export const pinUpdateScript = `
function updatePins(ids){
  const pinned=new Set(ids);
  document.querySelectorAll('button[data-pin-id]').forEach(button=>{
    const value=pinned.has(button.dataset.pinId),label=value?'ピン留めを解除':'メモをピン留め';
    button.setAttribute('aria-pressed',String(value));button.setAttribute('aria-label',label);button.title=label;
  });
}
window.addEventListener('message',event=>{if(event.data.type==='pins')updatePins(event.data.ids);});
`;
