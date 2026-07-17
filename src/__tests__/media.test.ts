import {
  attachmentFilename,
  buildRef,
  declaredSizeBytes,
  describeMedia,
  extOf,
  FILE_DOC_TYPE,
  inputPeerFor,
  MEDIA_SIZE_CAP_BYTES,
  parseRef,
  peerOfEntity,
} from '../media';

describe('describeMedia', () => {
  it('maps photos to image with a jpeg mime (Telegram server-transcodes all photos)', () => {
    expect(describeMedia({ className: 'MessageMediaPhoto', photo: {} })).toEqual(
      { kind: 'image', mimeType: 'image/jpeg' },
    );
  });

  it('maps voice documents to audio with duration', () => {
    const media = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'audio/ogg',
        attributes: [
          { className: 'DocumentAttributeAudio', voice: true, duration: 65 },
        ],
      },
    };
    expect(describeMedia(media)).toEqual({
      kind: 'audio',
      mimeType: 'audio/ogg',
      durationSec: 65,
    });
  });

  it('maps named documents with filename', () => {
    const media = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'application/pdf',
        attributes: [
          { className: 'DocumentAttributeFilename', fileName: 'invoice.pdf' },
        ],
      },
    };
    expect(describeMedia(media)).toEqual({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
    });
  });

  it('maps stickers, videos, image-mime documents', () => {
    const sticker = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'image/webp',
        attributes: [{ className: 'DocumentAttributeSticker' }],
      },
    };
    expect(describeMedia(sticker)?.kind).toBe('sticker');
    const video = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'video/mp4',
        attributes: [{ className: 'DocumentAttributeVideo', duration: 9 }],
      },
    };
    expect(describeMedia(video)).toEqual({
      kind: 'video',
      mimeType: 'video/mp4',
      durationSec: 9,
    });
    const gifLike = {
      className: 'MessageMediaDocument',
      document: { mimeType: 'image/png', attributes: [] },
    };
    expect(describeMedia(gifLike)?.kind).toBe('image');
  });

  it('returns undefined for webpages, polls, and unknowns', () => {
    expect(describeMedia({ className: 'MessageMediaWebPage' })).toBeUndefined();
    expect(describeMedia({ className: 'MessageMediaPoll' })).toBeUndefined();
    expect(describeMedia(undefined)).toBeUndefined();
  });
});

describe('sizes and names', () => {
  it('reads declared document size incl. BigInteger-like values', () => {
    const doc = (size: unknown) => ({
      className: 'MessageMediaDocument',
      document: { size, attributes: [] },
    });
    expect(declaredSizeBytes(doc(1234))).toBe(1234);
    expect(declaredSizeBytes(doc({ toJSNumber: () => 99 }))).toBe(99);
    expect(
      declaredSizeBytes({ className: 'MessageMediaPhoto', photo: {} }),
    ).toBeUndefined();
  });

  it('synthesizes filenames per kind', () => {
    expect(attachmentFilename({ kind: 'document', filename: 'a.pdf' })).toBe(
      'a.pdf',
    );
    expect(attachmentFilename({ kind: 'image' })).toBe('photo.jpg');
    expect(attachmentFilename({ kind: 'audio' })).toBe('voice-note.ogg');
    expect(attachmentFilename({ kind: 'video' })).toBe('video.mp4');
    expect(attachmentFilename({ kind: 'sticker' })).toBe('sticker.webp');
  });

  it('extracts extensions', () => {
    expect(extOf('a.PDF')).toBe('pdf');
    expect(extOf('noext')).toBeUndefined();
  });

  it('exports constants', () => {
    expect(FILE_DOC_TYPE).toBe('telegram.file');
    expect(MEDIA_SIZE_CAP_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('refs', () => {
  it('round-trips a ref', () => {
    const ref = { chatId: '-100123', msgId: 7, peer: 'channel' as const, accessHash: '99' };
    expect(parseRef(buildRef(ref))).toEqual(ref);
  });

  it('rejects garbage', () => {
    expect(parseRef('not json')).toBeNull();
    expect(parseRef(JSON.stringify({ chatId: 'x' }))).toBeNull();
    expect(parseRef(42)).toBeNull();
  });

  it('builds real GramJS input peers', () => {
    expect(
      (inputPeerFor({ chatId: '42', msgId: 1, peer: 'user', accessHash: '7' }) as { className: string })
        .className,
    ).toBe('InputPeerUser');
    expect(
      (inputPeerFor({ chatId: '-9', msgId: 1, peer: 'chat' }) as { className: string }).className,
    ).toBe('InputPeerChat');
    expect(
      (inputPeerFor({ chatId: '-100123', msgId: 1, peer: 'channel', accessHash: '8' }) as { className: string })
        .className,
    ).toBe('InputPeerChannel');
  });

  it('classifies entities for refs', () => {
    expect(peerOfEntity({ className: 'User', accessHash: { toString: () => '5' } }))
      .toEqual({ peer: 'user', accessHash: '5' });
    expect(peerOfEntity({ className: 'Chat' })).toEqual({ peer: 'chat' });
    expect(peerOfEntity({ className: 'Channel', accessHash: { toString: () => '6' } }))
      .toEqual({ peer: 'channel', accessHash: '6' });
    expect(peerOfEntity(null)).toBeNull();
  });
});
