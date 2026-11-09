export type Tool = 'select' | 'pen' | 'eraser'

/** x, y in page units (PDF points at 100% zoom, top-left origin), pressure 0..1 */
export type Point = [number, number, number]

export interface StrokeAnn {
  id: string
  kind: 'stroke'
  page: number
  points: Point[]
  size: number
  color: string
  simulatePressure: boolean
}

export interface ImageAnn {
  id: string
  kind: 'image'
  page: number
  x: number
  y: number
  w: number
  h: number
  /** PNG data URL */
  src: string
}

export type Annotation = StrokeAnn | ImageAnn

export interface PageSize {
  width: number
  height: number
}

export interface SavedSignature {
  id: string
  src: string
  w: number
  h: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}
