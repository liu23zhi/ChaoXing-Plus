// Labeled fixtures for question extraction: what image evidence must reach the
// search prompt for an image-bearing stem or option.
//
// `expect` lists the hidden evidence spans in document order. Each span carries
// the alt transcription (when present) followed by the resolved absolute URL
// (when present). Fixtures mirror markup shapes documented by the reference
// projects (lazy `data-original`, `data-src`, relative `src`, alt-only formulas)
// and the failure modes of "just copy img.src".

export const extractionCases = [
  {
    id: 'legacy-lazy-data-original',
    note: 'Chaoxing lazy loader keeps the real file in data-original; src is a placeholder',
    baseURI: 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWork',
    images: [
      { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', dataOriginal: 'https://p.ananas.chaoxing.com/star3/origin/aa11.png' }
    ],
    expect: ['https://p.ananas.chaoxing.com/star3/origin/aa11.png']
  },
  {
    id: 'lazy-data-src',
    note: 'Newer pages use data-src and leave src empty',
    baseURI: 'https://mooc1.chaoxing.com/',
    images: [{ src: '', dataSrc: 'https://p.ananas.chaoxing.com/star3/origin/bb22.png' }],
    expect: ['https://p.ananas.chaoxing.com/star3/origin/bb22.png']
  },
  {
    id: 'relative-src',
    note: 'Relative src must become an absolute URL the backend can download',
    baseURI: 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWork',
    images: [{ src: '/star3/origin/cc33.png' }],
    expect: ['https://mooc1.chaoxing.com/star3/origin/cc33.png']
  },
  {
    id: 'alt-only-formula',
    note: 'Image with alt transcription but no usable URL still carries text',
    baseURI: 'https://mooc1.chaoxing.com/',
    images: [{ alt: '公式 x+y=z' }],
    expect: ['公式 x+y=z']
  },
  {
    id: 'alt-plus-url-single-span',
    note: 'Alt and URL belong to one evidence node, not two',
    baseURI: 'https://mooc1.chaoxing.com/',
    images: [{ src: 'https://p.ananas.chaoxing.com/star3/origin/dd44.png', alt: '受力分析图' }],
    expect: ['受力分析图 https://p.ananas.chaoxing.com/star3/origin/dd44.png']
  },
  {
    id: 'two-images-order-mixed',
    note: 'Order must follow the images, mixing attribute sources',
    baseURI: 'https://mooc1.chaoxing.com/',
    images: [
      { src: '', dataOriginal: 'https://p.ananas.chaoxing.com/star3/origin/e1.png' },
      { src: 'https://p.ananas.chaoxing.com/star3/origin/e2.png', alt: '第二问' }
    ],
    expect: [
      'https://p.ananas.chaoxing.com/star3/origin/e1.png',
      '第二问 https://p.ananas.chaoxing.com/star3/origin/e2.png'
    ]
  },
  {
    id: 'javascript-url-guard',
    note: 'javascript: src is not evidence; keep only the alt transcription',
    baseURI: 'https://mooc1.chaoxing.com/',
    images: [{ src: 'javascript:alert(1)', alt: '电路图' }],
    expect: ['电路图']
  },
  {
    id: 'file-url-dropped',
    note: 'Non-http(s) URL with no alt yields no evidence at all',
    baseURI: 'https://mooc1.chaoxing.com/',
    images: [{ src: 'file:///C:/tmp/x.png' }],
    expect: []
  },
  {
    id: 'repeated-extraction-idempotent',
    note: 'Extracting the same question twice must not duplicate evidence',
    baseURI: 'https://mooc1.chaoxing.com/',
    extractTwice: true,
    images: [
      { src: 'https://p.ananas.chaoxing.com/star3/origin/f1.png', alt: '第一图' },
      { src: 'https://p.ananas.chaoxing.com/star3/origin/f2.png' }
    ],
    expect: [
      '第一图 https://p.ananas.chaoxing.com/star3/origin/f1.png',
      'https://p.ananas.chaoxing.com/star3/origin/f2.png'
    ]
  },
  {
    id: 'three-images-with-gap',
    note: 'A middle image without any usable source must not shift the others',
    baseURI: 'https://mooc1.chaoxing.com/',
    images: [
      { src: 'https://p.ananas.chaoxing.com/star3/origin/g1.png' },
      { src: 'about:blank' },
      { src: 'https://p.ananas.chaoxing.com/star3/origin/g3.png', alt: '第三图' }
    ],
    expect: [
      'https://p.ananas.chaoxing.com/star3/origin/g1.png',
      '第三图 https://p.ananas.chaoxing.com/star3/origin/g3.png'
    ]
  }
];

export default extractionCases;
