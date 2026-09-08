const verdictLabels = { needs_check: '要確認', rejected: '棄却', supported: '支持（証明の認定ではない）' };

export function reviewButtonHtml(member, message, escape) {
  if (!message.id || message.pending) return '';
  const role = message.role === 'assistant' ? 'Agentの回答' : '入力';
  const label = `${member.name}の${role}（発言ID: ${message.id}）に検証メモを追加`;
  return `<button type="button" class="sm" data-review-message="${escape(message.id)}" aria-label="${escape(label)}">検証メモを追加</button>`;
}

export function reviewNotesHtml(notes, escape, { key = '', open = false } = {}) {
  if (!notes.length) return '';
  return `<details class="message-reviews" data-review-key="${escape(key)}"${open ? ' open' : ''}><summary>検証メモ ${notes.length}件（評価の原文）</summary>
    ${notes.slice(-3).map(note => `<p><strong>${escape(verdictLabels[note.verdict] || note.verdict)}</strong> · ${escape(note.reviewer)}（自己申告）<br>${escape(note.at)}<br><span class="review-rationale">${escape(note.rationale)}</span></p>`).join('')}
    ${notes.length > 3 ? '<p class="small">最新3件を表示。全記録はワークスペースデータに保存されています。</p>' : ''}</details>`;
}

export function reviewSubmission(target, values) {
  const record = { memberId: target.memberId, messageId: target.messageId,
    verdict: values.verdict, rationale: values.rationale, reviewer: values.reviewer };
  if (!Object.hasOwn(verdictLabels, record.verdict) ||
      typeof record.rationale !== 'string' || !record.rationale.trim() || record.rationale.length > 2000 ||
      typeof record.reviewer !== 'string' || !record.reviewer.trim() || record.reviewer.length > 120) {
    throw new Error('評価、理由（1〜2000文字）、投稿者名（1〜120文字）を入力してください。');
  }
  record.rationale = record.rationale.trim();
  record.reviewer = record.reviewer.trim();
  return record;
}

export function openReviewDialog({ workspaceId, member, message, request, onSaved }) {
  if (document.getElementById('reviewNoteDialog')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'reviewNoteDialog';
  dialog.setAttribute('aria-labelledby', 'reviewNoteTitle');
  dialog.innerHTML = `<form id="reviewNoteForm">
    <h3 id="reviewNoteTitle">検証メモを追加</h3>
    <p>元の発言やキューは変更しません。評価は追記され、数学的な証明や投稿者本人の認証にはなりません。</p>
    <p id="reviewNoteSource"></p>
    <label>評価<select name="verdict" required aria-label="検証メモの評価">
      <option value="needs_check">要確認</option><option value="rejected">棄却</option><option value="supported">支持（証明の認定ではない）</option>
    </select></label>
    <label>理由<textarea name="rationale" required maxlength="2000" rows="5" aria-label="検証メモの理由"></textarea></label>
    <label>投稿者名（自己申告）<input name="reviewer" required maxlength="120" autocomplete="off" aria-label="検証メモの投稿者名"></label>
    <p id="reviewNoteError" role="alert"></p>
    <menu><button type="button" id="cancelReviewNote">キャンセル</button><button type="submit" id="saveReviewNote" class="primary">メモを保存</button></menu>
  </form>`;
  dialog.querySelector('#reviewNoteSource').textContent = `${member.name} / 発言 ${message.id}\n${String(message.content || '').slice(0, 300)}${String(message.content || '').length > 300 ? '…（抜粋）' : ''}`;
  document.body.append(dialog); // Outside #app: polling must not destroy drafts.
  const form = dialog.querySelector('form');
  const save = dialog.querySelector('#saveReviewNote');
  const cancel = dialog.querySelector('#cancelReviewNote');
  const error = dialog.querySelector('#reviewNoteError');
  let pending = false;
  const beforeUnload = event => {
    if (pending || form.elements.rationale.value || form.elements.reviewer.value) {
      event.preventDefault(); event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  cancel.onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    window.removeEventListener('beforeunload', beforeUnload);
    dialog.remove();
    document.querySelector(`.member[data-mid="${CSS.escape(member.id)}"] [data-review-message="${CSS.escape(message.id)}"]`)?.focus();
  }, { once: true });
  form.onsubmit = async event => {
    event.preventDefault();
    if (pending) return;
    error.textContent = '';
    let record;
    try {
      record = reviewSubmission({ memberId: member.id, messageId: message.id }, Object.fromEntries(new FormData(form)));
    } catch (e) { error.textContent = e.message; return; }
    pending = true; save.disabled = true; cancel.disabled = true;
    save.textContent = '保存中…';
    try {
      await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/reviews`, { method: 'POST', body: JSON.stringify(record) });
    } catch (e) {
      error.textContent = `${e.message}。通信が切れた場合は保存済みの可能性があります。再送前に履歴を確認してください。`;
      pending = false; save.disabled = false; cancel.disabled = false; save.textContent = 'メモを保存';
      return;
    }
    pending = false;
    dialog.close();
    onSaved();
  };
  dialog.showModal();
  form.elements.rationale.focus();
}
