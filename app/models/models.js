const {keyValues, difference, dbFriendly, notEmpty, empty, filter, deepMerge, merge, concat, compact, setIn, getIn, keys} = require('lib/util')
const config = require('app/config')
const {logger, mongo} = config.modules
const modelApi = require('lib/model_api')
const modelSpec = require('lib/model_spec')
const modelSchema = require('lib/model_spec_schema')
const requireSpaces = () => require('app/models/spaces')
const requireSwagger = () => require('app/swagger')
const jsonSchema = require('lib/json_schema')
const swaggerSchema = require('public/openapi-schema')
const {withoutRefs} = require('lib/json_schema')
const {validationError} = require('lib/errors')
const DEFAULTS = require('lib/model_spec').DEFAULTS

const PROPERTY_NAME_PATTERN = '^[a-zA-Z0-9_-]{1,30}$'
const coll = 'models'
const collSchema = getIn(modelSchema, ['properties', 'coll'])

async function getColl (model) {
  const space = model.spaceId && (await requireSpaces().get(model.spaceId))
  if (space && model.coll) {
    const prefix = 'm'
    const qualifier = space.databaseUrl ? undefined : space.dbKey
    return compact([prefix, qualifier, model.coll]).join('_')
  } else {
    return undefined
  }
}

async function validateDataLimit (doc, options) {
  const count = await options.api.count()
  if (count >= config.DATA_LIMIT) {
    throw validationError(options.model, doc, `You cannot create more than ${config.DATA_LIMIT} documents in your current plan`)
  }
  return doc
}

async function getApi (space, model) {
  const modelInstance = merge(model.model, {
    callbacks: {
      create: {
        beforeValidation: [validateDataLimit]
      }
    }
  })
  const mongo = await requireSpaces().getMongo(space)
  return modelApi(modelInstance, mongo, logger)
}

async function validateSpace (doc, options) {
  const accountId = getIn(options, 'account.id')
  if (doc.spaceId && !(await requireSpaces().get({id: doc.spaceId, accountId}))) {
    throw validationError(options.model, doc, `space '${doc.spaceId}' does not exist in account ${accountId}`, 'spaceId')
  } else {
    return doc
  }
}

function setDefaultColl (doc, options) {
  if (notEmpty(doc.name) && empty(doc.coll)) {
    return merge(doc, {coll: dbFriendly(doc.name)})
  }
}

async function setModelColl (doc, options) {
  const coll = await getColl(doc)
  if (coll) {
    return deepMerge(doc, {
      model: {
        coll,
        type: doc.coll
      }
    })
  } else {
    return doc
  }
}

async function setAccountId (doc, options) {
  if (!doc.spaceId) return doc
  const space = await requireSpaces().get(doc.spaceId)
  return merge(doc, {accountId: space.accountId})
}

async function setFeatures (doc, options) {
  if (doc.features) {
    const features = concat(modelSpec.DEFAULTS.features, doc.features)
    return setIn(doc, ['model', 'features'], features)
  } else {
    return doc
  }
}

async function setSchema (doc, options) {
  if (doc.model) {
    const xMeta = {
      writeRequiresAdmin: false,
      dataModel: true
    }
    return setIn(doc, ['model', 'schema', 'x-meta'], xMeta)
  } else {
    return doc
  }
}

function setPropertiesOrder (doc, options) {
  const properties = getIn(doc, 'model.schema.properties')
  if (empty(properties)) return
  const valid = filter((doc.propertiesOrder || []), (key) => keys(properties).includes(key))
  const missing = difference(keys(properties), valid)
  const propertiesOrder = concat(valid, missing)
  if (notEmpty(propertiesOrder)) {
    return merge(doc, {propertiesOrder})
  }
}

function validatePropertyNames (doc, options) {
  const propertyNames = keys(getIn(doc, 'model.schema.properties'))
  const invalidNames = filter(propertyNames, name => !name.match(new RegExp(PROPERTY_NAME_PATTERN)))
  if (notEmpty(invalidNames)) {
    throw validationError(options.model, doc, `The following field names are invalid: ${invalidNames.join(', ')}`)
  }
  return doc
}

async function validateModel (doc, options) {
  if (doc.model) modelApi(doc.model, mongo) // creating the API this should not throw any error
  return doc
}

async function validatePropertiesLimit (doc, options) {
  const properties = getIn(doc, ['model', 'schema', 'properties'])
  if (properties && keys(properties).length > config.PROPERTY_LIMIT) {
    throw validationError(options.model, doc, `You can not have more than ${config.PROPERTY_LIMIT} properties`)
  }
  return doc
}

async function validateModelsLimit (doc, options) {
  const modelsCount = doc.spaceId && (await modelApi({coll}, mongo).count({spaceId: doc.spaceId}))
  if (modelsCount && modelsCount >= config.MODELS_LIMIT) {
    throw validationError(options.model, doc, `You cannot have more than ${config.MODELS_LIMIT} models per space`)
  }
  return doc
}

const X_META_SCHEMA = {
  type: 'object',
  properties: {
    id: {type: 'boolean'},
    readable: {type: 'boolean'},
    writable: {type: 'boolean'},
    update: {type: 'boolean'},
    versioned: {type: 'boolean'},
    index: {type: ['boolean', 'integer']},
    unique: {type: 'boolean'},
    mergeChangelog: {type: 'boolean'},
    field: {
      type: 'object',
      properties: {
        name: {type: 'string'},
        type: {type: 'string'}
      },
      additionalProperties: false
    },
    relationship: {
      type: 'object',
      properties: {
        toType: collSchema,
        type: {enum: ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many']},
        // NOTE: the presence of a toField means the relationship is two-way
        toField: {type: 'string', pattern: PROPERTY_NAME_PATTERN},
        // NOTE: the name is the optional property name used when fetching relationships
        name: {type: 'string'},
        oneWay: {type: 'boolean'}
      },
      required: ['toType', 'type'],
      additionalProperties: false
    }
  },
  additionalProperties: false
}

function uniqueAllowed (property) {
  return ['string', 'integer', 'number'].includes(property.type)
}

// NOTE: Using this special case validation instead of patternProperties since
// patternProperties is not supported by OpenAPI
async function validateXMeta (doc, options) {
  const properties = getIn(doc, ['model', 'schema', 'properties'])
  if (empty(properties)) return
  for (let [key, property] of keyValues(properties)) {
    const xMeta = property['x-meta']
    if (xMeta) {
      const path = `model.schema.properties.${key}.x-meta`
      const errors = jsonSchema.validate(X_META_SCHEMA, xMeta, {path})
      if (errors) throw errors
      if (xMeta.unique && !uniqueAllowed(property)) {
        throw validationError(options.model, doc, `unique is not allowed for field`, path)
      }
    }
  }
}

async function validateSwagger (doc, options) {
  if (doc.model && doc.spaceId) {
    const swagger = requireSwagger()
    let systemSwagger = await swagger()
    let spaceSwagger = await swagger({spaceId: doc.spaceId, models: [doc]})
    for (let swagger of [systemSwagger, spaceSwagger]) {
      const errors = jsonSchema.validate(swaggerSchema, swagger)
      if (errors) throw errors
    }
  }
  return doc
}

async function validateCollAvailable (doc, options) {
  const coll = getIn(doc, ['model', 'coll'])
  if (coll && (await mongo.getColls()).includes(coll)) {
    throw validationError(options.model, doc, `'${doc.coll}' is not available - please choose another name`, 'coll')
  } else {
    return doc
  }
}

async function deleteColl (doc, options) {
  const coll = getIn(doc, ['model', 'coll'])
  const colls = await mongo.getColls()
  if (colls.includes(coll)) {
    await mongo.db().collection(coll).drop()
  }
  return doc
}

const model = {
  coll,
  features: concat(DEFAULTS.features, ['relationships_meta']),
  schema: {
    type: 'object',
    properties: {
      name: {type: 'string'},
      accountId: {type: 'string', 'x-meta': {write: false, index: true}},
      spaceId: {
        type: 'string',
        'x-meta': {
          update: false,
          index: true,
          relationship: {
            toType: 'spaces',
            toField: 'models',
            name: 'space',
            type: 'many-to-one'
          }
        }
      },
      coll: merge(collSchema, {'x-meta': {update: false, index: true}}),
      features: {type: 'array', items: {enum: ['published']}},
      propertiesOrder: {type: 'array', items: {type: 'string'}},
      model: withoutRefs(modelSchema)
    },
    required: ['name', 'spaceId', 'accountId', 'coll', 'model'],
    additionalProperties: false
  },
  callbacks: {
    save: {
      beforeValidation: [validateSpace, setDefaultColl, setModelColl, setAccountId, setFeatures, setSchema, validatePropertyNames, validateModel, validatePropertiesLimit, setPropertiesOrder],
      afterValidation: [validateXMeta, validateSwagger]
    },
    create: {
      beforeValidation: [validateCollAvailable, validateModelsLimit]
    },
    delete: {
      after: [deleteColl]
    }
  },
  indexes: [
    {
      keys: {'model.coll': 1},
      options: {unique: true}
    },
    {
      keys: {spaceId: 1, coll: 1},
      options: {unique: true}
    },
    {
      keys: {spaceId: 1, name: 1},
      options: {unique: true}
    }
  ]
}

module.exports = Object.assign(modelApi(model, mongo, logger), {
  getColl,
  getApi
})
