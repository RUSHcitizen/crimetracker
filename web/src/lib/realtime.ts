import type { ServerFrame } from '@crimetracker/shared';
import { useTracker } from '../state/store.js';

/**
 * WebSocket client with exponential backoff.
 *
 * Frames are validated only as far as "has a known `type`" — the server is the trust
 * boundary for content, and the store ignores anything it does not recognise.
 */
export class RealtimeClient {
  #socket: WebSocket | null = null;
  #retries = 0;
  #timer: number | null = null;
  #closedByUs = false;

  constructor(private readonly url: string = defaultUrl()) {}

  connect(): void {
    this.#closedByUs = false;
    this.#open();
  }

  disconnect(): void {
    this.#closedByUs = true;
    if (this.#timer !== null) window.clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.close();
    this.#socket = null;
  }

  #open(): void {
    useTracker.getState().setConnection('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#retries = 0;
      useTracker.getState().setConnection('open');
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      useTracker.getState().applyFrame(frame);
    };

    socket.onerror = () => {
      useTracker.getState().setConnection('error');
    };

    socket.onclose = () => {
      this.#socket = null;
      if (this.#closedByUs) {
        useTracker.getState().setConnection('closed');
        return;
      }
      useTracker.getState().setConnection('closed');
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect(): void {
    if (this.#closedByUs) return;
    // 500 ms → 8 s, with jitter so a restarted server is not hit by a thundering herd.
    const base = Math.min(8000, 500 * 2 ** this.#retries);
    const delay = base * (0.7 + Math.random() * 0.6);
    this.#retries += 1;
    this.#timer = window.setTimeout(() => this.#open(), delay);
  }
}

function defaultUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
