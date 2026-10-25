/**
 * Binary min-heap of integer items by numeric key. The pop order of equal keys depends only on
 * the push sequence, so searches built on it are deterministic.
 */
export class MinHeap {
  #items: number[] = [];
  #keys: number[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(item: number, key: number): void {
    const items = this.#items;
    const keys = this.#keys;
    let k = items.length;
    items.push(item);
    keys.push(key);
    while (k > 0) {
      const parent = (k - 1) >> 1;
      const parentKey = keys[parent] ?? 0;
      if (parentKey <= key) break;
      items[k] = items[parent] ?? 0;
      keys[k] = parentKey;
      k = parent;
    }
    items[k] = item;
    keys[k] = key;
  }

  pop(): number | undefined {
    const items = this.#items;
    const keys = this.#keys;
    const top = items[0];
    const lastItem = items.pop();
    const lastKey = keys.pop();
    if (items.length === 0 || lastItem === undefined || lastKey === undefined) return top;
    let k = 0;
    for (;;) {
      const left = 2 * k + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child = right < items.length && (keys[right] ?? 0) < (keys[left] ?? 0) ? right : left;
      const childKey = keys[child] ?? 0;
      if (childKey >= lastKey) break;
      items[k] = items[child] ?? 0;
      keys[k] = childKey;
      k = child;
    }
    items[k] = lastItem;
    keys[k] = lastKey;
    return top;
  }
}
