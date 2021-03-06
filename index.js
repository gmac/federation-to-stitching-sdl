const { stitchingDirectives } = require('@graphql-tools/stitching-directives');
const { parse, print, Kind, buildSchema } = require('graphql');
const defaultStitchingDirectives = stitchingDirectives();
const extensionKind = /Extension$/;
const entityKinds = [
  Kind.OBJECT_TYPE_DEFINITION,
  Kind.OBJECT_TYPE_EXTENSION,
  Kind.INTERFACE_TYPE_DEFINITION,
  Kind.INTERFACE_TYPE_EXTENSION,
];

function getQueryTypeDef(definitions) {
  const schemaDef = definitions.find(def => def.kind === Kind.SCHEMA_DEFINITION);
  const typeName = schemaDef ? schemaDef.operationTypes.find(({ operation }) => operation === 'query').type.name.value : 'Query';
  return definitions.find(def => def.kind === Kind.OBJECT_TYPE_DEFINITION && def.name.value === typeName);
}

// Federation services are actually fairly complex,
// as the `buildFederatedSchema` helper does a fair amount
// of hidden work to setup the Federation schema specification:
// https://www.apollographql.com/docs/federation/federation-spec/#federation-schema-specification
module.exports = function federationToStitchingSDL(federationSDL, stitchingConfig=null) {
  stitchingConfig = stitchingConfig || defaultStitchingDirectives;
  const doc = parse(federationSDL);
  const entityTypes = [];
  const baseTypeNames = doc.definitions.reduce((memo, typeDef) => {
    if (!extensionKind.test(typeDef.kind) && typeDef.name) {
      memo[typeDef.name.value] = true;
    }
    return memo;
  }, {});

  doc.definitions.forEach(typeDef => {
    // Un-extend all types (remove "extends" keywords)...
    // extended types are invalid GraphQL without a local base type to extend from.
    // Stitching merges flat types in lieu of hierarchical extensions.
    if (extensionKind.test(typeDef.kind) && !baseTypeNames[typeDef.name.value]) {
      typeDef.kind = typeDef.kind.replace(extensionKind, 'Definition');
    }

    if (!entityKinds.includes(typeDef.kind)) return;

    // Find object definitions with "@key" directives;
    // these are federated entities that get turned into merged types.
    const keyDirs = [];
    const otherDirs = [];
    typeDef.directives.forEach(dir => {
      if (dir.name.value === 'key') {
        keyDirs.push(dir);
      } else {
        otherDirs.push(dir);
      }
    });

    if (!keyDirs.length) return;

    // Setup stitching MergedTypeConfig for all federated entities:
    const selectionSet = `{ ${ keyDirs.map(dir => dir.arguments[0].value.value).join(' ') } }`;
    const keyFields = parse(selectionSet).definitions[0].selectionSet.selections.map(sel => sel.name.value);
    const keyDir = keyDirs[0];
    keyDir.name.value = stitchingConfig.keyDirective.name;
    keyDir.arguments[0].name.value = 'selectionSet';
    keyDir.arguments[0].value.value = selectionSet;
    typeDef.directives = [keyDir, ...otherDirs];

    // Remove non-key "@external" fields from the type...
    // the stitching query planner expects services to only publish their own fields.
    // This makes "@provides" moot because the query planner can automate the logic.
    typeDef.fields = typeDef.fields.filter(fieldDef => {
      return keyFields.includes(fieldDef.name.value) || !fieldDef.directives.find(dir => dir.name.value === 'external');
    });

    // Discard remaining "@external" directives and any "@provides" directives
    typeDef.fields.forEach(fieldDef => {
      fieldDef.directives = fieldDef.directives.filter(dir => !/^(external|provides)$/.test(dir.name.value));
      fieldDef.directives.forEach(dir => {
        if (dir.name.value === 'requires') {
          dir.name.value = stitchingConfig.computedDirective.name;
          dir.arguments[0].name.value = 'selectionSet';
          dir.arguments[0].value.value = `{ ${dir.arguments[0].value.value} }`;
        }
      });
    });

    if (typeDef.kind === Kind.OBJECT_TYPE_DEFINITION || typeDef.kind === Kind.OBJECT_TYPE_EXTENSION) {
      entityTypes.push(typeDef.name.value);
    }
  });

  // Federation service SDLs are incomplete because they omit the federation spec itself...
  // (https://www.apollographql.com/docs/federation/federation-spec/#federation-schema-specification)
  // To make federation SDLs into valid and parsable GraphQL schemas,
  // we must fill in the missing details from the specification.
  if (entityTypes.length) {
    const queryDef = getQueryTypeDef(doc.definitions);
    const entitiesSchema = parse(`
      scalar _Any
      union _Entity = ${entityTypes.filter((v, i, a) => a.indexOf(v) === i).join(' | ')}
      type Query { _entities(representations: [_Any!]!): [_Entity]! @${ stitchingConfig.mergeDirective.name } }
    `).definitions;

    doc.definitions.push(entitiesSchema[0]);
    doc.definitions.push(entitiesSchema[1]);

    if (queryDef) {
      queryDef.fields.push(entitiesSchema[2].fields[0]);
    } else {
      doc.definitions.push(entitiesSchema[2]);
    }
  }

  return [stitchingConfig.stitchingDirectivesTypeDefs, print(doc)].join('\n');
};
