import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blockDisplayWidth, getBlock, insertBlocks } from '../../../core/blocks';
import { LOCAL_ORIGIN } from '../../../core/storage/docstore';
import { altFromName, fitWithin, MAX_IMAGE_EDGE, prepareImage } from './imageImport';
import { hasAnnotations, setImageWidth, snapWidth, toggleAnnotations } from './ImageBlocks';
import { clampZoom, MAX_ZOOM, MIN_ZOOM } from '../../ink/FocusView';

describe('photo import', () => {
  it('fits large photos within the long-edge limit, keeps small ones', () => {
    expect(fitWithin(4032, 3024)).toEqual({ w: MAX_IMAGE_EDGE, h: 1920 });
    expect(fitWithin(3024, 4032)).toEqual({ w: 1920, h: MAX_IMAGE_EDGE });
    expect(fitWithin(1200, 800)).toBeNull();
    expect(fitWithin(0, 0)).toBeNull();
  });

  it('derives alt text from file names, not from generic camera names', () => {
    expect(altFromName('Whiteboard 3.jpeg')).toBe('Whiteboard 3');
    expect(altFromName('image.jpg')).toBeUndefined();
    expect(altFromName(undefined)).toBeUndefined();
  });

  it('keeps images it cannot decode byte-for-byte', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' });
    const out = await prepareImage(blob);
    expect(out.blob).toBe(blob);
    const gif = new Blob([new Uint8Array([1])], { type: 'image/gif' });
    expect((await prepareImage(gif)).blob).toBe(gif);
  });
});

describe('image size and annotations', () => {
  function image() {
    const doc = new Y.Doc();
    const [id] = insertBlocks(doc, [{ type: 'image', image: { blobId: 'b', w: 800, h: 600 } }]);
    return { doc, block: getBlock(doc, id)! };
  }

  it('snaps widths to quarters and clamps', () => {
    expect(snapWidth(0.49)).toBe(0.5);
    expect(snapWidth(0.6)).toBe(0.6);
    expect(snapWidth(1.4)).toBe(1);
    expect(snapWidth(0.01, 0.1)).toBe(0.1);
  });

  it('stores the width as a fraction; full width removes the field (undoable)', () => {
    const { doc, block } = image();
    const um = new Y.UndoManager([doc.getMap('blocks')], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
    setImageWidth(block, 0.5);
    expect(blockDisplayWidth(block)).toBe(0.5);
    setImageWidth(block, 1);
    expect(block.has('displayWidth')).toBe(false);
    um.undo();
    expect(blockDisplayWidth(block)).toBe(0.5);
  });

  it('knows when a photo has annotations and toggles their visibility', () => {
    const { block } = image();
    expect(hasAnnotations(block)).toBe(false);
    block.doc!.transact(() => {
      const arr = new Y.Array();
      arr.push([{ id: 's', pts: [0, 0, 0.5], color: '#e5484d', size: 3, tool: 'pen' }]);
      block.set('strokes', arr);
    });
    expect(hasAnnotations(block)).toBe(true);
    toggleAnnotations(block);
    expect(block.get('annotationsHidden')).toBe(true);
    toggleAnnotations(block);
    expect(block.has('annotationsHidden')).toBe(false);
  });
});

describe('focus view zoom', () => {
  it('clamps zoom', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1.23456)).toBe(1.235);
  });
});
