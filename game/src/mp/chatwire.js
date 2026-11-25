// Shared wire sanitation; deliberately no word filter.
export function chatText(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return text.length > 0 && text.length <= 200 ? text : null;
}
