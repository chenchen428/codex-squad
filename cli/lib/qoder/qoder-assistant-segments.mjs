export function createQoderAssistantSegments() {
  const messages = new Map();
  let active = null;

  return {
    append(messageId, value) {
      const sourceMessageId = String(messageId || 'assistant');
      const chunk = String(value || '');
      const state = messages.get(sourceMessageId) || { fullText: '', segmentIndex: 0, segmentStart: 0 };
      state.fullText = chunk.startsWith(state.fullText) ? chunk : `${state.fullText}${chunk}`;
      messages.set(sourceMessageId, state);

      if (!active || active.sourceMessageId !== sourceMessageId) {
        state.segmentIndex += 1;
        active = {
          sourceMessageId,
          itemId: `${sourceMessageId}:segment:${state.segmentIndex}`,
          content: '',
        };
      }
      active.content = state.fullText.slice(state.segmentStart);
      return active.content ? { ...active } : null;
    },

    boundary() {
      if (!active) return null;
      const completed = { ...active };
      const state = messages.get(active.sourceMessageId);
      if (state) state.segmentStart = state.fullText.length;
      active = null;
      return completed.content ? completed : null;
    },

    complete() {
      return this.boundary();
    },

    text() {
      return [...messages.values()].map((state) => state.fullText).filter(Boolean).join('\n');
    },
  };
}
