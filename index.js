#!/usr/bin/env node
const { Source, buildSchema } = require('graphql');
const gql = require('graphql-tag');

const fs = require('fs');
const path = require('path');
const program = require('commander');
const del = require('del');

program
  .option('--schemaFilePath [value]', 'path of your graphql schema file')
  .option('--destDirPath [value]', 'dir you want to store the generated queries')
  .option('--depthLimit [value]', 'query depth you want to limit(The default is 100)')
  .option('--typesPath [value]', 'path to your generated typescript file with GraphQL Types')
  .option('--withMongo [value]', 'set as true if you are using @graphql-codegen/typescript-mongodb')
  .parse(process.argv);

console.log();
const { schemaFilePath, destDirPath, typesPath, depthLimit = 100, withMongo = false } = program;

const pathToDestDir = `${process.cwd()}${destDirPath}`;
const pathToTypes = `${process.cwd()}${typesPath}`;
const typesRelativePathWithExtension = path.relative(pathToDestDir, pathToTypes);
const typesRelativePath = typesRelativePathWithExtension.replace(path.extname(typesRelativePathWithExtension), '');

const typeDef = fs.readFileSync(schemaFilePath);

let gqlSchema
try {
  const source = new Source(typeDef);
  gqlSchema = buildSchema(source);
} catch(e) {
  const { buildFederatedSchema } = require('@apollo/federation');

  gqlSchema = buildFederatedSchema([
    {
      typeDefs: gql`
        ${typeDef}
      `,
    },
  ]);
}

del.sync(destDirPath);
path
  .resolve(destDirPath)
  .split(path.sep)
  .reduce((before, cur) => {
    const pathTmp = path.join(before, cur + path.sep);
    if (!fs.existsSync(pathTmp)) {
      fs.mkdirSync(pathTmp);
    }
    return path.join(before, cur + path.sep);
  }, '');

/**
 * Generate the query for the specified field
 * @param curName name of the current field
 * @param curParentType parent type of the current field
 * @param curParentName parent name of the current field
 * @param argumentList list of arguments from all fields
 * @param crossReferenceKeyList list of the cross reference
 * @param curDepth currentl depth of field
 */
const generateQuery = (
  curName,
  curParentType,
  curParentName,
  argumentList = [],
  crossReferenceKeyList = [], // [`${curParentName}To${curName}Key`]
  curDepth = 1
) => {
  const field = gqlSchema.getType(curParentType).getFields()[curName];
  const curTypeName = field.type.inspect().replace(/[[\]!]/g, '');
  const curType = gqlSchema.getType(curTypeName);
  let queryStr = '';
  let childQuery = '';

  // const filtered = curType.toConfig().astNode.fields.filter(f => !f.directives.find(d => (d.name.value === "column" || d.name.value === "id" || d.name.value === "embedded" || d.name.value === "link")))

  if (curType.getFields) {
    const crossReferenceKey = `${curParentName}To${curName}Key`;
    if (crossReferenceKeyList.indexOf(crossReferenceKey) !== -1 || curDepth > depthLimit) return '';
    crossReferenceKeyList.push(crossReferenceKey);
    const childKeys = Object.keys(curType.getFields());
    childQuery = childKeys
      .filter(k => {
        if (withMongo) {
          return curType.getFields()[k].astNode.directives.find(d => (d.name.value === "column" || d.name.value === "id" || d.name.value === "embedded" || d.name.value === "link"));
        } else {
          return true;
        }
      })
      .map((cur) => generateQuery(cur, curType, curName, argumentList, crossReferenceKeyList, curDepth + 1).queryStr)
      .filter((cur) => cur)
      .join('\n');
  }

  if (!(curType.getFields && !childQuery)) {
    queryStr = `${'    '.repeat(curDepth)}${field.name}`;
    if (field.args.length > 0) {
      argumentList.push(...field.args);
      const argsStr = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(', ');
      queryStr += `(${argsStr})`;
    }
    if (childQuery) {
      queryStr += `{\n${childQuery}\n${'    '.repeat(curDepth)}}`;
    }
  }

  /* Union types */
  if (curType.astNode && curType.astNode.kind === 'UnionTypeDefinition') {
    const types = curType.getTypes();
    if (types && types.length) {
      const indent = `${'    '.repeat(curDepth)}`;
      const fragIndent = `${'    '.repeat(curDepth + 1)}`;
      queryStr += '{\n';

      for (let i = 0, len = types.length; i < len; i++) {
        const valueTypeName = types[i];
        const valueType = gqlSchema.getType(valueTypeName);
        const unionChildQuery = Object.keys(valueType.getFields())
          .map(
            (cur) => generateQuery(cur, valueType, curName, argumentList, crossReferenceKeyList, curDepth + 2).queryStr
          )
          .filter((cur) => cur)
          .join('\n');
        queryStr += `${fragIndent}... on ${valueTypeName} {\n${unionChildQuery}\n${fragIndent}}\n`;
      }
      queryStr += `${indent}}`;
    }
  }
  return { queryStr, argumentList };
};

const templateContext = { mutations: [], queries: [], subscriptions: [], pathToTypes: typesRelativePath };

/**
 * Generate the query for the specified field
 * @param obj one of the root objects(Query, Mutation, Subscription)
 * @param description description of the current object
 */
const generateFile = (obj, description) => {
  let indexJs = "import gql from \"graphql-tag\";\nconst fs = require('fs');\nconst path = require('path');\n\n";
  let outputFolderName;
  switch (description) {
    case 'Mutation':
      outputFolderName = 'mutations';
      break;
    case 'Query':
      outputFolderName = 'queries';
      break;
    case 'Subscription':
      outputFolderName = 'subscriptions';
      break;
    default:
      console.log('[gqlg warning]:', 'description is required');
  }
  const writeFolder = path.join(destDirPath, `./${outputFolderName}`);
  fs.mkdirSync(writeFolder);
  Object.keys(obj)
    .filter((t) => t !== '_entities' && t !== '_service')
    .forEach((type) => {
      console.log(type);
      const queryResult = generateQuery(type, description);
      let query = queryResult.queryStr;
      const field = gqlSchema.getType(description).getFields()[type];
      const args = field.args.concat(queryResult.argumentList);
      const argStr = args
        .filter((item, pos) => args.indexOf(item) === pos)
        .map((arg) => `$${arg.name}: ${arg.type}`)
        .join(', ');
      query = `${description.toLowerCase()} ${type}${argStr ? `(${argStr})` : ''}{\n${query}\n}`;
      fs.writeFileSync(path.join(writeFolder, `./${type}.graphql`), query);
      indexJs += `export const ${type} = gql\`$\{fs.readFileSync(path.join(__dirname, '${type}.graphql'), 'utf8')}\`;\n`;
      templateContext[outputFolderName].push({ name: type, hasVariables: !!argStr });
    });
  fs.writeFileSync(path.join(writeFolder, 'index.ts'), indexJs);
};

if (gqlSchema.getMutationType()) {
  generateFile(gqlSchema.getMutationType().getFields(), 'Mutation');
} else {
  console.log('[gqlg warning]:', 'No mutation type found in your schema');
}

if (gqlSchema.getQueryType()) {
  generateFile(gqlSchema.getQueryType().getFields(), 'Query');
} else {
  console.log('[gqlg warning]:', 'No query type found in your schema');
}

if (gqlSchema.getSubscriptionType()) {
  generateFile(gqlSchema.getSubscriptionType().getFields(), 'Subscription');
} else {
  console.log('[gqlg warning]:', 'No subscription type found in your schema');
}
const Handlebars = require('handlebars');

Handlebars.registerHelper('toUpperCase', function (s) {
  if (typeof s !== 'string') return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
});

const rootTemplate = fs.readFileSync(path.join(__dirname, './root.handlebars'), 'utf8');

const generateIndex = () => Handlebars.compile(rootTemplate)(templateContext);

fs.writeFileSync(path.join(destDirPath, 'index.ts'), generateIndex());
require('./generateModule');
