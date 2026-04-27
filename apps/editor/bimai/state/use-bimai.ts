import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type BimAIPanel = 'project' | 'zoning' | 'program' | null

type BimAIState = {
  activePanel: BimAIPanel
  setActivePanel: (p: BimAIPanel) => void
  // Future phases will add: optimizer state, generation history, etc.
}

export const useBimAI = create<BimAIState>()(
  persist(
    (set) => ({
      activePanel: null,
      setActivePanel: (activePanel) => set({ activePanel }),
    }),
    { name: 'bimai-ui' },
  ),
)
