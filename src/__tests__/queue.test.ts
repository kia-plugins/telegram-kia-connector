import { AsyncBatchQueue } from '../queue';

describe('AsyncBatchQueue', () => {
  it('delivers pushed items in FIFO order', async () => {
    const q = new AsyncBatchQueue<number>();
    q.push(1);
    q.push(2);
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBe(2);
  });

  it('parks next() until an item arrives', async () => {
    const q = new AsyncBatchQueue<string>();
    const pending = q.next();
    q.push('late');
    expect(await pending).toBe('late');
  });

  it('drains queued items then yields null after close', async () => {
    const q = new AsyncBatchQueue<number>();
    q.push(1);
    q.close();
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBeNull();
  });

  it('close wakes a parked consumer; pushes after close are dropped', async () => {
    const q = new AsyncBatchQueue<number>();
    const pending = q.next();
    q.close();
    expect(await pending).toBeNull();
    q.push(9);
    expect(await q.next()).toBeNull();
  });
});
