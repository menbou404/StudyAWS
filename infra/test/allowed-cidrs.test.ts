import { parseAllowedCidrs } from '../lib/allowed-cidrs';

describe('allowedCidrs の入力検証', () => {
  test.each([undefined, '', ' , , \t '])('未指定や空要素は受信許可を作らない: %p', value => {
    expect(parseAllowedCidrs(value)).toEqual([]);
  });

  test('空白と空要素を除去し、同じ CIDR は重複させない', () => {
    expect(parseAllowedCidrs(' 203.0.113.10/32, ,198.51.100.0/24, 203.0.113.10/32 '))
      .toEqual(['203.0.113.10/32', '198.51.100.0/24']);
  });

  test.each([
    '203.0.113.10',
    '999.0.113.10/32',
    '203.0.113.10/33',
    '203.0.113.10/-1',
    '203.0.113.10/032',
    'example.com/32',
    '203.0.113.10/32/32',
    '::/0',
    123,
    ['203.0.113.10/32'],
    null,
  ])('不正な CIDR や文字列以外は拒否する: %p', value => {
    expect(() => parseAllowedCidrs(value)).toThrow();
  });

  test.each(['0.0.0.0/0', '203.0.113.10/0'])('全世界公開になる /0 は拒否する: %s', value => {
    expect(() => parseAllowedCidrs(value)).toThrow('/0');
  });
});
