export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]+/g, '-');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(name: string, text: string, mime = 'text/plain') {
  downloadBlob(name, new Blob([text], { type: `${mime};charset=utf-8` }));
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    };
    // resolve empty if the dialog is dismissed (focus returns without change)
    window.addEventListener(
      'focus',
      () =>
        setTimeout(() => {
          if (!input.files?.length) resolve([]);
        }, 800),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}
