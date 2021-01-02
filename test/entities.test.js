const federationToStitchingSDL = require('../index');

describe('federation annotations', () => {

  const federationSdl = `
    extend type Product implements IProduct @key(fields: "id") {
      id: ID! @external
    }

    extend interface IProduct @key(fields: "id") {
      id: ID! @external
    }
  `;

  test('removes type extensions', async () => {
    const result = federationToStitchingSDL(federationSdl);
    expect(result).not.toMatch(/^extend type Product/m);
    expect(result).not.toMatch(/^extend interface IProduct/m);
    expect(result).toMatch(/^type Product/m);
    expect(result).toMatch(/^interface IProduct/m);
  });
});