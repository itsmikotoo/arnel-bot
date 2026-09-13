// Coalesce text that arrives during generation, not only during the initial debounce.
export function createTextTurnQueue({ delayMs, onTurn, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const chats = new Map();
  let closed = false;

  async function drain(chatId, state) {
    if (closed || state.running || state.timer !== null || !state.pending.length) return;
    state.running = true;
    const batch = state.pending.splice(0);
    const revision = state.revision;
    const isCurrent = () => !closed && state.revision === revision;
    try {
      const result = await onTurn(chatId, batch, isCurrent);
      if (result?.retry && !closed && state.pending.length) state.pending.unshift(...batch);
    } catch (error) {
      // Preserve unsent input when newer text superseded a failed generation.
      if (!closed && !error.turnDelivered && state.pending.length) state.pending.unshift(...batch);
      onError(error);
    } finally {
      state.running = false;
      if (!closed) {
        if (state.pending.length && state.timer === null) void drain(chatId, state);
        else if (!state.pending.length && state.timer === null) chats.delete(chatId);
      }
    }
  }

  return {
    push(chatId, item) {
      if (closed) return;
      let state = chats.get(chatId);
      if (!state) {
        state = { pending: [], revision: 0, running: false, timer: null };
        chats.set(chatId, state);
      }
      state.pending.push(item);
      state.revision++;
      if (state.timer !== null) clearTimer(state.timer);
      state.timer = setTimer(() => {
        state.timer = null;
        void drain(chatId, state);
      }, delayMs);
    },
    close() {
      closed = true;
      for (const state of chats.values()) if (state.timer !== null) clearTimer(state.timer);
      chats.clear();
    },
  };
}

// Recheck after the typing delay too: new input must stop unsent stale bubbles.
export async function deliverReplyParts(parts, { isCurrent, beforeSend, send }) {
  const sent = [];
  try {
    for (const [index, part] of parts.entries()) {
      if (!isCurrent()) break;
      await beforeSend(part, index);
      if (!isCurrent()) break;
      await send(part, index);
      sent.push(part);
    }
    return { sent, retry: !sent.length && !isCurrent() };
  } catch (error) {
    error.sentParts = sent;
    error.turnDelivered = sent.length > 0;
    throw error;
  }
}
