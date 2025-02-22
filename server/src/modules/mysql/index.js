const DB = require('../../db.js')
const log = require('tangy-log').log
const clog = require('tangy-log').clog
const fs = require('fs-extra');
const groupsList = require('/tangerine/server/src/groups-list.js')
const util = require('util');
const exec = util.promisify(require('child_process').exec)
const { spawn } = require('child_process');
const fsCore = require('fs');
const readFile = util.promisify(fsCore.readFile);
const createGroupDatabase = require('../../create-group-database.js')
const { v4: uuidv4 } = require('uuid');
const groupReportingViews = require(`./views.js`)

/* Enable this if you want to run commands manually when debugging.
const exec = async function(cmd) {
  console.log(cmd) 
}
*/

async function insertGroupReportingViews(groupName) {
  let designDoc = Object.assign({}, groupReportingViews)
  let groupDb = new DB(`${groupName}-mysql`)
  try {
    let status = await groupDb.post(designDoc)
    log.info(`group reporting views inserted into ${groupName}-reporting`)
  } catch (error) {
    log.error(error)
  }

  // sanitized
  groupDb = new DB(`${groupName}-mysql-sanitized`)
  try {
    let status = await groupDb.post(designDoc)
    log.info(`group reporting views inserted into ${groupName}-reporting-sanitized`)
  } catch (error) {
    log.error(error)
  }
}

module.exports = {
  name: 'mysql',
  hooks: {
    boot: async function(data) {
      const groups = await groupsList()
      for (groupId of groups) {

        const pathToStateFile = `/mysql-module-state/${groupId}.ini`
        startTangerineToMySQL(pathToStateFile)
      }
      return data
    },
    enable: async function() {
      const groups = await groupsList()
      for (groupId of groups) {
        await initializeGroupForMySQL(groupId)
        await createGroupDatabase(groupId, '-mysql')
        await createGroupDatabase(groupId, '-mysql-sanitized')
      }
    },
    disable: function(data) {

    },
    groupNew: async function(data) {
      const {groupName} = data
      const groupId = groupName
      await initializeGroupForMySQL(groupId)
      const pathToStateFile = `/mysql-module-state/${groupId}.ini`
      // startTangerineToMySQL(pathToStateFile)
      await createGroupDatabase(groupName, '-mysql')
      await createGroupDatabase(groupName, '-mysql-sanitized')
      await insertGroupReportingViews(groupName)
      return data
    },
    clearReportingCache: async function(data) {
      console.log("clearReportingCache hook")
      const { groupNames } = data
      for (let groupName of groupNames) {
        await removeGroupForMySQL(groupName)
        await initializeGroupForMySQL(groupName)
        console.log(`removing db ${groupName}-mysql`)
        let db = new DB(`${groupName}-mysql`)
        await db.destroy()
        await createGroupDatabase(groupName, '-mysql')
        db = new DB(`${groupName}-mysql-sanitized`)
        await db.destroy()
        await createGroupDatabase(groupName, '-mysql-sanitized')
        await insertGroupReportingViews(groupName)
      }
      return data
    },
    reportingOutputs: async function(data) {
      async function generateDatabase(sourceDb, targetDb, doc, sanitized, exclusions) {
        if (exclusions && exclusions.includes(doc.form.id)) {
          // skip!
        } else {
          if (doc.type === 'case') {
            // output case
            await saveFlatResponse(doc, targetDb, sanitized);

            // output participants
            for (const participant of doc.participants) {
              let participant_id = participant.id
              if (process.env.T_MYSQL_MULTI_PARTICIPANT_SCHEMA) {
                participant_id = doc._id + '-' + participant.id
              }
              await pushResponse({
                ...participant,
                _id: participant_id,
                caseId: doc._id,
                participantId: participant.id,
                type: "participant",
                archived: doc.archived||''
              }, targetDb);
            }
          
            // output case-events
            for (const event of doc.events) {
              // output event-forms
              if (event['eventForms']) {
                for (const eventForm of event['eventForms']) {
                  // for (let index = 0; index < event['eventForms'].length; index++) {
                  // const eventForm = event['eventForms'][index]
                  try {
                    await pushResponse({...eventForm, type: "event-form", _id: eventForm.id, archived: doc.archived}, targetDb);
                  } catch (e) {
                    if (e.status !== 404) {
                      console.log("Error processing eventForm: " + JSON.stringify(e) + " e: " + e)
                    }
                  }
                }
              } else {
                console.log("Mysql - NO eventForms! doc _id: " + doc._id + " in database " +  sourceDb.name + " event: " + JSON.stringify(event))
              }
              // Make a clone of the event so we can delete part of it but not lose it in other iterations of this code
              // Note that this clone is only a shallow copy; however, it is safe to delete top-level properties.
              const eventClone = Object.assign({}, event);
              // Delete the eventForms array from the case-event object - we don't want this duplicate structure 
              // since we are already serializing each event-form and have the parent caseEventId on each one.
              delete eventClone.eventForms
              await pushResponse({...eventClone, _id: eventClone.id, type: "case-event", archived: doc.archived}, targetDb)
            }
          } else {
            await saveFlatResponse(doc, targetDb, sanitized);
          }
        }
      }
        
      const {doc, sourceDb} = data
      // const groupsDb = new PouchDB(`${process.env.T_COUCHDB_ENDPOINT}/groups`)
      const groupsDb = await new DB(`groups`);
      const groupDoc = await groupsDb.get(`${sourceDb.name}`)
      const exclusions = groupDoc['exclusions']
      // First generate the full-cream database
      let mysqlDb
      try {
        mysqlDb = await new DB(`${sourceDb.name}-mysql`);
      } catch (e) {
        console.log("Error creating db: " + JSON.stringify(e))
      }
      let sanitized = false;
      await generateDatabase(sourceDb, mysqlDb, doc, sanitized, exclusions);
      
      // Then create the sanitized version
      let mysqlSanitizedDb
      try {
        mysqlSanitizedDb = await new DB(`${sourceDb.name}-mysql-sanitized`);
      } catch (e) {
        console.log("Error creating db: " + JSON.stringify(e))
      }
      sanitized = true;
      await generateDatabase(sourceDb, mysqlSanitizedDb, doc, sanitized, exclusions);
      return data
    }
  }
}

async function removeGroupForMySQL(groupId) {
  const mysqlDbName = groupId.replace(/-/g,'')
  await exec(`mysql -u ${process.env.T_MYSQL_USER} -h mysql -p"${process.env.T_MYSQL_PASSWORD}" -e "DROP DATABASE ${mysqlDbName};"`)
  const pathToStateFile = `/mysql-module-state/${groupId}.ini`
  await fs.unlink(pathToStateFile)
  console.log(`Removed state file and database for ${groupId}`)
 
}

async function initializeGroupForMySQL(groupId) {
  const mysqlDbName = groupId.replace(/-/g,'')
  console.log(`Creating mysql db ${mysqlDbName}`)
  try {
    await exec(`mysql -u ${process.env.T_MYSQL_USER} -h mysql -p"${process.env.T_MYSQL_PASSWORD}" -e "CREATE DATABASE ${mysqlDbName};"`)
  } catch (e) {
    console.log(`Error creating mysql db ${mysqlDbName}`)
    console.log(e)
  }
  console.log(`Created mysql db ${mysqlDbName}`)
  console.log('Creating tangerine to mysql state file...')
  const state = `[TANGERINE]
DatabaseURL = http://couchdb:5984/
DatabaseName = ${groupId}-mysql
DatabaseUserName = ${process.env.T_COUCHDB_USER_ADMIN_NAME} 
DatabasePassword = ${process.env.T_COUCHDB_USER_ADMIN_PASS} 
LastSequence = 0

[MySQL]
HostName = mysql 
DatabaseName = ${mysqlDbName} 
UserName = ${process.env.T_MYSQL_USER} 
Password = ${process.env.T_MYSQL_PASSWORD} 
  `
  const pathToStateFile = `/mysql-module-state/${groupId}.ini`
  await fs.writeFile(pathToStateFile, state)
  console.log('Created tangerine to mysql state file.')
}

async function startTangerineToMySQL(pathToStateFile) {
  try {
    const cmd = `python3 /tangerine/server/src/modules/mysql/TangerineToMySQL.py ${pathToStateFile}`
    const script = spawn(`python3`, ['/tangerine/server/src/modules/mysql/TangerineToMySQL.py', pathToStateFile],{ env: { ...process.env, PYTHONIOENCODING: 'utf8' } })
    script.stdout.on('data', (data) => {
      log.info(`${cmd} -- ${data}`)
    })
    script.stderr.on('data', (data) => {
      log.error(`${cmd} -- ${data}`)
    });
    script.on('close', (code) => {
      console.log(`child process exited with code ${code}`);
    });
    log.info(`Running: ${cmd}`)
  } catch(e) {
    console.error(e)
  }
}

const getItemValue = (doc, variableName) => {
  const variablesByName = doc.items.reduce((variablesByName, item) => {
    for (const input of item.inputs) {
      variablesByName[input.name] = input.value;
    }
    return variablesByName;
  }, {});
  return variablesByName[variableName];
};


/** This function processes form response, making the data structure flatter.
 *
 * @param {object} formData - form response from database
 * @param {boolean} sanitized - flag if data must filter data based on the identifier flag.
 *
 * @returns {object} processed results for csv
 */

const generateFlatResponse = async function (formResponse, sanitized) {
  if (formResponse.form.id === '') {
    formResponse.form.id = 'blank'
  }
  let flatFormResponse = {
    _id: formResponse._id,
    formId: formResponse.form.id,
    formTitle: formResponse.form.title,
    startUnixtime: formResponse.startUnixtime,
    endUnixtime: formResponse.endUnixtime||'',
    buildId: formResponse.buildId||'',
    buildChannel: formResponse.buildChannel||'',
    deviceId: formResponse.deviceId||'',
    groupId: formResponse.groupId||'',
    complete: formResponse.complete,
    archived: formResponse.archived||''
  };
  for (let item of formResponse.items) {
    for (let input of item.inputs) {
      let sanitize = false;
      if (sanitized) {
        if (input.identifier) {
          sanitize = true
        }
      }
      if (!sanitize) {
      // Simplify the keys by removing formID.itemId
      let firstIdSegment = ""
      if (input.tagName === 'TANGY-LOCATION') {
        // Populate the id, label and metadata columns for TANGY-LOCATION levels in the current location list.
        // The location list may be change over time. When values are changed, we attempt to adjust 
        // so the current values appear in the outputs.

        // This input has an attribute 'locationSrc' with a path to the location list that starts with './assets/'
        // We need to compare file names instead of paths since it is different on the server
        const locationSrc = input.locationSrc ? path.parse(input.locationSrc).base : `location-list.json`
        const locationList = await tangyModules.getLocationListsByLocationSrc(groupId, locationSrc)
        locationKeys = []
        for (let group of input.value) {
          tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}.${group.level}`, group.value)
          locationKeys.push(group.value)

          if (!locationList) {
            // Since tangy-form v4.42.0, tangy-location widget saves the label in the value
            // use the label value saved in the form response if it is not found in the current location list.
            // If no label appears in the form response, then we put 'orphanced' for the label. 
            const valueLabel = group.label ? group.label : 'orphaned'
            tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}.${group.level}_label`, valueLabel)
          } else {
            try {
              const location = getLocationByKeys(locationKeys, locationList)
              for (let keyName in location) {
                if (['descendantsCount', 'children', 'parent', 'id'].includes(keyName)) {
                  continue
                }
                tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}.${group.level}_${keyName}`, location[keyName])                
              }
            } catch (e) {
              const valueLabel = group.label ? group.label : 'orphaned'
              tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}.${group.level}_label`, valueLabel)
            }
          }
        }
      } else if (input.tagName === 'TANGY-RADIO-BUTTONS' && Array.isArray(input.value)) {
        let selectedOption = input.value.find(option => !!option.value) 
        tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}`, selectedOption ? selectedOption.name : '')
      } else if (input.tagName === 'TANGY-PHOTO-CAPTURE') {
        tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}`, input.value ? 'true' : 'false')
      } else if (input.tagName === 'TANGY-VIDEO-CAPTURE') {
        tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}`, input.value ? 'true' : 'false')
      } else if (input && typeof input.value === 'string') {
        tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}`, input.value)
      } else if (input && typeof input.value === 'number') {
        tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}`, input.value)
      } else if (input && Array.isArray(input.value)) {
        for (let group of input.value) {
          tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}.${group.name}`, group.value)
        }
      } else if ((input && typeof input.value === 'object') && (input && !Array.isArray(input.value)) && (input && input.value !== null)) {
        let elementKeys = Object.keys(input.value);
        for (let key of elementKeys) {
          tangyModules.setVariable(flatFormResponse, input, `${firstIdSegment}${input.name}.${key}`, input.value[key])
        };
      }
      } // sanitize
    }
  }
  return flatFormResponse;
};

function pushResponse(doc, db) {
  return new Promise((resolve, reject) => {
    // If there are any objects/arrays in the flatResponse, stringify them. Also make all property names lowercase to avoid duplicate column names (example: ID and id are different in python/js, but the same for MySQL leading attempting to create duplicate column names of id and ID).
    if (doc.data && typeof doc.data === 'object') {
      doc.data = Object.keys(doc.data).reduce((acc, key) => {
        return {
          ...acc,
          ...key === ''
            ? {}
            : {
                [key.toLowerCase()]: typeof doc.data[key] === 'object'
                  ? JSON.stringify(doc.data[key])
                  : doc.data[key]
              }
        }
      }, {})
    }
    db.get(doc._id)
      .then(oldDoc => {
        // Overrite the _rev property with the _rev in the db and save again.
        const updatedDoc = Object.assign({}, doc, { _rev: oldDoc._rev });
        db.put(updatedDoc)
          .then(_ => resolve(true))
          .catch(error => reject(`mysql pushResponse could not overwrite ${doc._id} to ${db.name} because Error of ${JSON.stringify(error)}`))
      })
      .catch(error => {
        const docClone = Object.assign({}, doc);
        // Make a clone of the doc so we can delete part of it but not lose it in other iterations of this code
        // Note that this clone is only a shallow copy; however, it is safe to delete top-level properties.
        // delete the _rev property from the docClone
        delete docClone._rev
        db.put(docClone)
          .then(_ => resolve(true))
          .catch(error => reject(`mysql pushResponse could not save ${docClone._id} to ${docClone.name} because Error of ${JSON.stringify(error)}`))
    });
  })
}

async function saveFlatResponse(doc, targetDb, sanitized) {
  let flatResponse = await generateFlatResponse(doc, sanitized);
  // If there are any objects/arrays in the flatResponse, stringify them. Also make all property names lowercase to avoid duplicate column names (example: ID and id are different in python/js, but the same for MySQL leading attempting to create duplicate column names of id and ID).
  flatResponse = Object.keys(flatResponse).reduce((acc, key) => {
    return {
      ...acc,
      ...key === ''
        ? {}
        : {
            [key.toLowerCase()]: typeof flatResponse[key] === 'object'
              ? JSON.stringify(flatResponse[key])
              : flatResponse[key]
          }
    }
  }, {})
  // make sure the top-level properties of doc are copied.
  const topDoc = {}
  Object.entries(doc).forEach(([key, value]) => value === Object(value) ? null : topDoc[key] = value);
  await pushResponse({...topDoc,
    data: flatResponse
  }, targetDb);
}

function getLocationByKeys(keys, locationList) {
  let locationKeys = [...keys]
  let currentLevel = locationList.locations[locationKeys.shift()]
  for (let key of locationKeys ) {
    currentLevel = currentLevel.children[key]
  }
  return currentLevel
}

// From: https://stackoverflow.com/a/61602592
const flatten = (obj, roots = [], sep = '.') => Object
  // find props of given object
  .keys(obj)
  // return an object by iterating props
  .reduce((memo, prop) => Object.assign(
    // create a new object
    {},
    // include previously returned object
    memo,
    Object.prototype.toString.call(obj[prop]) === '[object Object]'
      // keep working if value is an object
      ? flatten(obj[prop], roots.concat([prop]))
      // include current prop and value and prefix prop with the roots
      : {[roots.concat([prop]).join(sep)]: obj[prop]}
  ), {})