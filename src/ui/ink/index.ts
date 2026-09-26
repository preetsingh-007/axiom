/** Ink UI: whiteboard blocks, toolbar and tool state. */
export { InkCanvas, NEEDS_AI_MESSAGE, type InkCanvasProps } from './InkCanvas';
export { InkToolbar, INK_TOOLS, useInkShortcuts, isEditableTarget, type InkToolbarProps } from './InkToolbar';
export {
  useInkStore,
  INK_COLORS,
  HIGHLIGHTER_COLORS,
  PEN_SIZES,
  HIGHLIGHTER_SIZES,
  ERASER_RADIUS,
  strokeWidthFor,
  isDrawingTool,
  type InkTool,
  type InkState,
} from './inkStore';
export { InkSurface, type InkSelection, type SurfaceCallbacks, type DragTransform } from './surface';
export type { InkAI } from '../../core/ink/beautify';
