/**
 * Parser for NBDT "WA GROUPS" text exports: group prose + WhatsApp-style lines.
 * Section delimiters: <FIN>, <END>, <EDN> (case-insensitive).
 */

/** First line of header used as canonical source_group label (trimmed). */
function sourceGroupFromHeader(header) {
  const line = header.split('\n').find((l) => l.trim().length > 0) || '';
  return line.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function descriptionFromHeader(header) {
  const lines = header.split('\n').map((l) => l.trim());
  if (lines.length <= 1) return '';
  return lines.slice(1).join('\n').trim();
}

/**
 * @param {string} messagePart - text starting at first [h:mm AM/PM, m/d/yyyy] line
 * @returns {Array<{ wa_time: string, wa_date: string, message_author: string, message_text: string }>}
 */
function extractStandardMessages(messagePart) {
  const messages = [];
  const re =
    /\[(\d{1,2}:\d{2}\s*(?:AM|PM)),\s*(\d{1,2}\/\d{1,2}\/\d{4})\]\s*([^:\n]+):\s*/gi;
  const starts = [];
  let m;
  while ((m = re.exec(messagePart)) !== null) {
    starts.push({
      wa_time: m[1],
      wa_date: m[2],
      message_author: m[3].trim(),
      index: m.index,
      fullLen: m[0].length,
    });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const bodyStart = s.index + s.fullLen;
    const bodyEnd = i + 1 < starts.length ? starts[i + 1].index : messagePart.length;
    const message_text = messagePart.slice(bodyStart, bodyEnd).trim();
    messages.push({
      wa_time: s.wa_time,
      wa_date: s.wa_date,
      message_author: s.message_author,
      message_text,
    });
  }
  return messages;
}

/**
 * @param {string} text - full file contents
 * @returns {{
 *   sections: Array<{
 *     source_group: string,
 *     group_description: string,
 *     format: 'standard' | 'fragmented',
 *     messages: Array<object>,
 *     raw_message_tail: string
 *   }>
 * }}
 */
export function parseWaGroupsExport(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const chunks = normalized.split(/<(?:FIN|END|EDN)>\s*/i).map((s) => s.trim()).filter(Boolean);

  const sections = [];
  for (const chunk of chunks) {
    const firstBracket = chunk.search(
      /\[\d{1,2}:\d{2}\s*(?:AM|PM),\s*\d{1,2}\/\d{1,2}\/\d{4}\]/i,
    );
    const header = firstBracket >= 0 ? chunk.slice(0, firstBracket).trim() : chunk.trim();
    const messagePart = firstBracket >= 0 ? chunk.slice(firstBracket) : '';
    const source_group = sourceGroupFromHeader(header);
    const group_description = descriptionFromHeader(header);

    const messages = extractStandardMessages(messagePart);
    const format =
      messages.length > 0
        ? 'standard'
        : messagePart.replace(/\s+/g, '').length > 20
          ? 'fragmented'
          : 'standard';

    sections.push({
      source_group,
      group_description,
      format,
      messages,
      raw_message_tail: format === 'fragmented' ? messagePart.trim().slice(0, 8000) : '',
    });
  }

  return { sections };
}

/**
 * Flatten to one JSON object per message (for JSONL ingest pipelines).
 */
export function sectionsToJsonlRecords(parsed, { includeDescription = false } = {}) {
  const rows = [];
  let globalIndex = 0;
  parsed.sections.forEach((sec, sectionIndex) => {
    sec.messages.forEach((msg, messageIndex) => {
      const row = {
        idx: globalIndex++,
        section_index: sectionIndex,
        message_index: messageIndex,
        source_group: sec.source_group,
        format: sec.format,
        wa_time: msg.wa_time,
        wa_date: msg.wa_date,
        message_author: msg.message_author,
        message_text: msg.message_text,
      };
      if (includeDescription && sec.group_description) {
        row.group_description = sec.group_description;
      }
      rows.push(row);
    });
    if (sec.format === 'fragmented' && sec.messages.length === 0) {
      rows.push({
        idx: globalIndex++,
        section_index: sectionIndex,
        message_index: -1,
        source_group: sec.source_group,
        format: 'fragmented',
        wa_time: null,
        wa_date: null,
        message_author: null,
        message_text: sec.raw_message_tail,
        parser_note:
          'No [h:mm AM/PM, m/d/yyyy] Author: lines found; tail stored in message_text for manual split',
      });
    }
  });
  return rows;
}
