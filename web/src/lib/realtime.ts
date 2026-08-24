import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { hasToken } from './api';

export interface CardUpdate {
  periodId: string;
  thesisId: string;
  status: 'available' | 'locked' | 'taken';
  lockedUntil?: string;
}

type CardListener = (update: CardUpdate) => void;
type BannerListener = (payload: { message: string; at: string }) => void;

let socket: Socket | null = null;
const cardListeners = new Set<CardListener>();
const bannerListeners = new Set<BannerListener>();

/** Connects (or returns existing) with the stored session JWT. */
export function connectRealtime(): Socket | null {
  if (!hasToken()) return null;
  if (socket?.connected) return socket;

  const accessToken = localStorage.getItem('access_token');
  socket = io('/', {
    transports: ['websocket'],
    auth: { token: accessToken },
    reconnectionDelayMax: 5000,
  });

  socket.on('war.card', (payload: CardUpdate) => {
    for (const fn of cardListeners) fn(payload);
  });
  socket.on('banner', (payload) => {
    for (const fn of bannerListeners) fn(payload);
  });
  return socket;
}

export function joinLobby(periodId: string): void {
  socket?.emit('lobby.subscribe', { periodId });
}

export function onCardUpdate(fn: CardListener): () => void {
  cardListeners.add(fn);
  return () => cardListeners.delete(fn);
}

export function onBanner(fn: BannerListener): () => void {
  bannerListeners.add(fn);
  return () => bannerListeners.delete(fn);
}
