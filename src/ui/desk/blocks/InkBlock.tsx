import { memo } from 'react';
import type { BlockMap, BlockSnapshot } from '../../../core/blocks';
import { INK_LOGICAL_WIDTH } from '../../../core/schema';
import { InkCanvas } from '../../ink/InkCanvas';
import { inkToSvg } from '../../../core/ink/render';
import { useServices } from '../../app/services';
import type { AIRouter } from '../../../core/ai/router';

/** Whiteboard block: hosts the low-latency ink canvas. */
export const InkBlock = memo(function InkBlock({ block, readOnly }: { block: BlockMap; id: string; readOnly?: boolean }) {
  const services = useServices();
  const ai = services.ai as AIRouter | undefined;
  return <InkCanvas block={block} readOnly={readOnly} ai={ai} />;
});

/** Standalone SVG for drag-out / export of an ink block. */
export function inkSvgForExport(b: BlockSnapshot): string {
  if (b.type !== 'ink' || !b.strokes) return '';
  return inkToSvg(b.strokes, b.beautified, INK_LOGICAL_WIDTH, b.height ?? 300, { crop: true });
}
