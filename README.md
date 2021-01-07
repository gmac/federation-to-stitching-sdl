# Federation SDL to Stitching SDL

This utility converts an [Apollo Federation SDL](https://www.apollographql.com/docs/federation/federation-spec/) string into a [Schema Stitching SDL](https://www.graphql-tools.com/docs/stitch-directives-sdl/) string. Schema Stitching supports freeform service bindings that may integrate with any GraphQL query, including the `_entities` query setup by [Federation services](https://github.com/apollographql/federation). That means any Federation SDL may be converted to stitching directives and plugged into a Schema Stitching gateway. For example...

**Federation SDL**

```graphql
type Widget @key(fields: 'id') {
  id: ID! @external
  name: String
  price: Int @external
  shippingCost: Int @requires(fields: 'price')
  parent: Widget @provides(fields: 'price')
}
```

**Stitching SDL**

```graphql
type Widget @key(selectionSet: '{ id }') {
  id: ID!
  name: String
  shippingCost: Int @computed(selectionSet: '{ price }')
  parent: Widget
}

scalar _Any
union _Entity = Widget

type Query {
  _entities(representations: [_Any!]!): [_Entity]! @merge
}
```

The translated SDL is configured for use with the Schema Stitching query planner, see complete [translation logic summary](#translation-logic) below.

## Usage

Install the package:

```shell
npm install federation-to-stitching-sdl
```

Convert a Federation SDL:

```js
const federationToStitchingSDL = require('federation-to-stitching-sdl');
const { stitchingDirectives } = require('@graphql-tools/stitching-directives');

// stitchingConfig is an optional argument,
// and is only needed when customizing stitching directive names.
const stitchingConfig = stitchingDirectives();
const stitchingSDL = federationToStitchingSDL(federationSDL, stitchingConfig);
```

## Example

A complete example can be found in the [Schema Stitching Handbook](https://github.com/gmac/schema-stitching-handbook/tree/master/federation-services). An extremely compact example of a Stitched gateway built using Federation services looks like this:

```js
const federationToStitchingSDL = require('federation-to-stitching-sdl');
const { stitchSchemas } = require('@graphql-tools/stitch');
const { stitchingDirectives } = require('@graphql-tools/stitching-directives');
const { stitchingDirectivesTransformer } = stitchingDirectives();
const { buildSchema, print } = require('graphql');
const { fetch } = require('cross-fetch');

function makeRemoteExecutor(url) {
  return async ({ document, variables }) => {
    const query = typeof document === 'string' ? document : print(document);
    const result = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return result.json();
  };
}

async function fetchFederationSubschema(url) {
  const executor = makeRemoteExecutor(url);
  const { data } = await executor({ document: '{ _service { sdl } }' });
  const sdl = federationToStitchingSDL(data._service.sdl);
  return {
    schema: buildSchema(sdl),
    executor,
  };
}

const gatewaySchema = stitchSchemas({
  subschemaConfigTransforms: [stitchingDirectivesTransformer],
  subschemas: await Promise.all([
    fetchFederationSubschema('http://localhost:4001/graphql'),
    fetchFederationSubschema('http://localhost:4002/graphql'),
    fetchFederationSubschema('http://localhost:4003/graphql'),
  ])
});
```

## Translation logic

Federation and Stitching use fundamentally similar patterns to combine underlying subservices (in fact, both tools have shared origins in [Apollo Stitching](https://www.apollographql.com/docs/federation/migrating-from-stitching/)). However, Federation SDLs are nuanced because they are incomplete (per the [spec](https://www.apollographql.com/docs/federation/federation-spec/)), they may contain baseless type extensions (which is invalid GraphQL), and they may contain fields that the service has no data for (so called "external" fields). These nuances are normalized for Schema Stitching as follows:

1. Turn all baseless type extensions into base types.
1. `@key(fields: "id")` becomes `@key(selectionSet: "{ id }")`.
1. `@requires(fields: "price")` becomes `@computed(selectionSet: "{ price }")`.
1. Fields with an `@external` directive are removed from the schema _unless they are part of the `@key`_. Stitching expects schemas to only publish fields that they actually have data for. This is considerably simpler than the Federation approach where services may be responsible for data they don't have. Remaining `@external` directives are discarded.
1. By eliminating the indirection of `@external` fields, the `@provides` directive is no longer necessary and can be discarded. Stitching's query planner can automate the optimial selection of as many fields as possible from as few services as possible.
1. Find the names of all Entity types marked with `@key`. If there are one or more Entity names:
  * Add an `_Any` scalar.
  * Add an `_Entity` union populated with all `@key` type names.
  * Add an `_entities(representations: [_Any!]!): [_Entity]! @merge` query.
1. Prepend stitching directives type definition string to the SDL.
