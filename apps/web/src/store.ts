import { create } from 'zustand';

interface UiState {
  selectedGroupJid: string | null;
  setSelectedGroupJid: (jid: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedGroupJid: null,
  setSelectedGroupJid: (jid) => set({ selectedGroupJid: jid }),
}));
