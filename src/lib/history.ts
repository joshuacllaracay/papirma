import type { Annotation } from '../types'

export interface HistoryState {
  past: Annotation[][]
  present: Annotation[]
  future: Annotation[][]
}

export type HistoryAction =
  | { type: 'add'; item: Annotation }
  | { type: 'remove'; ids: string[] }
  | { type: 'update'; id: string; patch: Partial<Annotation> }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset' }

export const initialHistory: HistoryState = { past: [], present: [], future: [] }

const LIMIT = 200

function commit(state: HistoryState, next: Annotation[]): HistoryState {
  return { past: [...state.past, state.present].slice(-LIMIT), present: next, future: [] }
}

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'add':
      return commit(state, [...state.present, action.item])
    case 'remove': {
      const ids = new Set(action.ids)
      const next = state.present.filter((a) => !ids.has(a.id))
      return next.length === state.present.length ? state : commit(state, next)
    }
    case 'update':
      return commit(
        state,
        state.present.map((a) => (a.id === action.id ? ({ ...a, ...action.patch } as Annotation) : a)),
      )
    case 'undo':
      if (!state.past.length) return state
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
      }
    case 'redo':
      if (!state.future.length) return state
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
      }
    case 'reset':
      return initialHistory
  }
}
