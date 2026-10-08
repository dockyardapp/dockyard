import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { DEFAULT_ROW_CAP, useRowCap } from './useRowCap';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('useRowCap', () => {
  it('passes a short list through untouched', () => {
    const { result } = renderHook(() => useRowCap([1, 2, 3], 3));
    expect(result.current.visible).toEqual([1, 2, 3]);
    expect(result.current.capped).toBe(false);
    expect(result.current.hiddenCount).toBe(0);
  });

  it('caps a long list and reports how many rows are withheld', () => {
    const { result } = renderHook(() => useRowCap(range(10), 4));
    expect(result.current.visible).toEqual([0, 1, 2, 3]);
    expect(result.current.hiddenCount).toBe(6);
    expect(result.current.capped).toBe(true);
  });

  it('reveals everything once showAll is called', () => {
    const { result } = renderHook(() => useRowCap(range(10), 4));
    act(() => {
      result.current.showAll();
    });
    expect(result.current.visible).toHaveLength(10);
    expect(result.current.capped).toBe(false);
    expect(result.current.hiddenCount).toBe(0);
  });

  it('handles an empty list without reporting a cap', () => {
    const { result } = renderHook(() => useRowCap<number>([], 4));
    expect(result.current.visible).toEqual([]);
    expect(result.current.capped).toBe(false);
  });

  it('defaults to the shared cap', () => {
    const { result } = renderHook(() => useRowCap(range(DEFAULT_ROW_CAP + 10)));
    expect(result.current.visible).toHaveLength(DEFAULT_ROW_CAP);
    expect(result.current.hiddenCount).toBe(10);
  });
});
