import { SyncDirection } from './sync-direction.enum';
import { TangyFormsInfoService } from 'src/app/tangy-forms/tangy-forms-info-service';
import { AppConfigService } from 'src/app/shared/_services/app-config.service';
import { DeviceService } from './../device/services/device.service';
import { SyncCustomService, SyncCustomDetails } from './sync-custom.service';
import {SyncCouchdbService, SyncCouchdbDetails, LocationQuery} from './sync-couchdb.service';
import { UserDatabase } from 'src/app/shared/_classes/user-database.class';
import { UserService } from 'src/app/shared/_services/user.service';
import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { ReplicationStatus } from './classes/replication-status.class';
import {Subject} from 'rxjs';
import {CaseService} from "../case/services/case.service";
import {CaseDefinitionsService} from "../case/services/case-definitions.service";
import {TangyFormService} from "../tangy-forms/tangy-form.service";
import {VariableService} from "../shared/_services/variable.service";
import * as moment from 'moment'
import {AppConfig} from "../shared/_classes/app-config.class";
import {FormInfo} from "../tangy-forms/classes/form-info.class";
import { createSyncFormIndex } from './create-sync-form-index';
import PouchDB from 'pouchdb'


export const SYNC_MODE_CUSTOM = 'SYNC_MODE_CUSTOM'
export const SYNC_MODE_COUCHDB = 'SYNC_MODE_COUCHDB'
export const SYNC_MODE_ALL = 'SYNC_MODE_ALL'

@Injectable({
  providedIn: 'root'
})
export class SyncService {

  constructor(
    private http: HttpClient,
    private syncCouchdbService:SyncCouchdbService,
    private syncCustomService:SyncCustomService,
    private deviceService:DeviceService,
    private appConfigService:AppConfigService,
    private userService:UserService,
    private tangyFormsInfoService:TangyFormsInfoService,
    private caseService: CaseService,
    private caseDefinitionsService: CaseDefinitionsService,
    private tangyFormService: TangyFormService,
    private variableService: VariableService
  ) { }

  syncMessage: any = {};
  public readonly syncMessage$: Subject<any> = new Subject();
  public readonly onCancelled$: Subject<any> = new Subject();
  replicationStatus: ReplicationStatus
  syncCouchdbServiceStartTime:string
  syncCouchdbServiceEndime:string
  compareDocsStartTime: string
  compareLimit: number = 150
  batchSize: number = 200
  writeBatchSize: number = 50
  reducedBatchSize: number = 10
  reducedWriteBatchSize: number = 10
  reducedCompareLimit: number = 10

  cancel() {
    this.syncCouchdbService.cancel()
  }
  
  async getStorageStats() {
    return new Promise(function (resolve, reject) {
      window['cordova'].exec(resolve, reject, "File", "getFreeDiskSpace", [])
    })
  }
  
  async sync(isFirstSync = false, fullSync?:SyncDirection, reduceBatchSize = false):Promise<ReplicationStatus> {
    const appConfig = await this.appConfigService.getAppConfig()
    const device = await this.deviceService.getDevice()
    const formInfos = await this.tangyFormsInfoService.getFormsInfo()
    const userDb = new UserDatabase('shared', 'shared', device.key, device._id, true)
    const initialPushLastSeq = await this.variableService.get('sync-push-last_seq')
    
    this.syncCouchdbService.syncMessage$.subscribe({
      next: (replicationStatus) => {
        this.syncMessage$.next(replicationStatus)
      }
    })

    this.syncCouchdbService.onCancelled$.subscribe({
      next: (replicationStatus) => {
        this.onCancelled$.next(replicationStatus)
      }
    })

    this.syncCouchdbServiceStartTime = new Date().toISOString()

    this.replicationStatus = await this.syncCouchdbService.sync(
      userDb,
      <SyncCouchdbDetails>{
        serverUrl: appConfig.serverUrl,
        groupId: appConfig.groupId,
        deviceId: device._id,
        deviceToken: device.token,
        deviceSyncLocations: device.syncLocations,
        formInfos,
        disableDeviceUserFilteringByAssignment: appConfig.disableDeviceUserFilteringByAssignment
      },
      null,
      isFirstSync,
      fullSync,
      reduceBatchSize
    )
    console.log('Finished syncCouchdbService sync: ' + JSON.stringify(this.syncMessage))

    /**
     * Delete archived docs
     */

    // TODO Enable once we understand the implications of deleting local docs flagged with `archived`
    // const deletedArchivedDocs = await this.deleteArchivedDocs(userDb.db, initialPushLastSeq)
    // if (deletedArchivedDocs > 0) {
    //   this.replicationStatus.deletedArchivedDocs = deletedArchivedDocs
    // }
    
    /**
     * Calculating Sync stats
     */
    
    if (fullSync) {
      this.replicationStatus.fullSync = fullSync
    } 
    this.syncCouchdbServiceEndime = new Date().toISOString()

    if (appConfig.calculateLocalDocsForLocation) {
      let formStats = await this.calculateLocalDocsForLocation(appConfig, userDb, formInfos);
      this.replicationStatus.localDocsForLocation = formStats
    }
    const start = moment(this.syncCouchdbServiceStartTime)
    const end = moment(this.syncCouchdbServiceEndime)
    const diff = end.diff(start)
    const duration = moment.duration(diff).as('milliseconds')
    // const durationUTC = moment.utc(duration).format('HH:mm:ss')
    let storageAvailable;

    if (window['isCordovaApp']) {
      storageAvailable = await this.getStorageStats()
    }

    try {
      // reset pullConflicts - we don't want to send these stats.
      this.replicationStatus.pullConflicts = []
      this.replicationStatus.syncCouchdbServiceStartTime = this.syncCouchdbServiceStartTime
      this.replicationStatus.syncCouchdbServiceEndime = this.syncCouchdbServiceEndime
      this.replicationStatus.syncCouchdbServiceDuration = duration
      this.replicationStatus.storageAvailable = storageAvailable
      await this.addDeviceSyncMetadata();

      this.syncMessage$.next({
        message: window['t']('Sending sync status to server. Please wait...')
      })
      
      await this.deviceService.didSync(this.replicationStatus)
    } catch (e) {
      this.syncMessage$.next({message: window['t']('Error sending sync status to server: ' + e)})
      console.log("Error: " + e)
    }
    
    if (
      isFirstSync ||
      (!isFirstSync && !appConfig.indexViewsOnlyOnFirstSync)
    ) {
      this.syncMessage$.next({ 
        message: window['t']('Optimizing data. This may take several minutes. Please wait...'),
        remaining: null
      })
      await this.indexViews(null)
    }
    return this.replicationStatus
  }

  private async addDeviceSyncMetadata() {
    const deviceInfo = await this.deviceService.getAppInfo()
    this.replicationStatus.deviceInfo = deviceInfo
    const userDb = await this.userService.getUserDatabase()
    const dbDocCount = (await userDb.db.info()).doc_count
    this.replicationStatus.dbDocCount = dbDocCount
    const connection = navigator['connection']
    const effectiveType = connection.effectiveType;
    const downlink = connection.downlink;
    const downlinkMax = connection.downlinkMax;
    this.replicationStatus.effectiveConnectionType = effectiveType
    this.replicationStatus.networkDownlinkSpeed = downlink
    this.replicationStatus.networkDownlinkMax = downlinkMax
    const userAgent = navigator['userAgent']
    this.replicationStatus.userAgent = userAgent
  }

  async calculateLocalDocsForLocation(appConfig: AppConfig, userDb: UserDatabase, formInfos: Array<FormInfo>) {
    
    this.syncMessage$.next({
      message: window['t']('Sync is complete; calculating sync statistics. Please wait...')
    })
    
    let formStats

      try {
        if (!await this.variableService.get('first-index-for-sync-formids')) {
          this.syncMessage$.next({
            message: window['t']('Need to build an index for the form id count. Please wait...')
          })
        }
        if (!await this.variableService.get('ran-update-v3.16.3')) {
          console.log('Adding _design/sync-formids view')
          await this.createSyncFormIndex()
          await this.variableService.set('ran-update-v3.16.3', 'true')
        }
        
        const r = await userDb.query('sync-formids')
        if (!await this.variableService.get('first-index-for-sync-formids')) {
          await this.variableService.set('first-index-for-sync-formids', 'true')
          this.syncMessage$.next({
            message: window['t']('Built an index for the form id count. Thanks for waiting!')
          })
        }
        const count = r.rows.length
        formStats = count
      } catch (e) {
        console.log("Error getting formStats: " + e)
      }
    return formStats;
  }

  /**
   * Sync Protocol 2 view indexer. This excludes views for SP1 and includes custom views from content developers.
   * 
   * @param username - only passed in when restoring a database.
   */
  async indexViews(username) {
    let db
    if (username) {
      db = await this.userService.getUserDatabase(username)
    } else {
      db = await this.userService.getUserDatabase()
    }
    
    let viewsToOptimize = []
    const appConfig = await this.appConfigService.getAppConfig()
    if (appConfig.homeUrl === 'case-home') {
      // Optimize views used on case home page.
      viewsToOptimize.push('search')
      viewsToOptimize.push('case-events-by-all-days')
      // This one is used for finding user profiles to associate an account with.
      viewsToOptimize.push('tangy-form/responsesByFormId')
      // Optimize all custom views.
      try {
        let queryJs = await this.http.get('./assets/queries.js', {responseType: 'text'}).toPromise()
        let queries;
        eval(`queries = ${queryJs}`)
        for (const query of queries) {
          viewsToOptimize.push(query.id)
        }
      } catch (e) { }
    } else {
      // Not using case-home? We'll optimize everything and expect the Content Developer to add views they don't need to the AppConfig.doNotOptimize array.
      const result = await db.allDocs({start_key: "_design/", end_key: "_design0", include_docs: true}) 
      for (let row of result.rows) {
        if (row.doc.views) {
          for (let viewId in row.doc.views) {
            viewsToOptimize.push(`${row.doc._id.replace('_design/', '')}/${viewId}`)
          }
        }
      }
    }
    if (appConfig.doNotOptimize && Array.isArray(appConfig.doNotOptimize)) {
      viewsToOptimize = viewsToOptimize.filter(view => !appConfig.doNotOptimize.includes(view))
    }
    console.log(`Indexing ${viewsToOptimize.length} views.`)
    let i = 0
    const numberOfSequencesInDb = (await db.db.changes({descending: true, limit: 1})).last_seq
    db.db.on('indexing', async (progress) => {
      const percentComplete = Math.round( 
        ( 
          (i * numberOfSequencesInDb) + ( progress.last_seq ? progress.last_seq : 0 )
        ) 
        /
        ( 
          viewsToOptimize.length * numberOfSequencesInDb
        )
        * 100
      )
      this.syncMessage$.next({ syncMessage: `${window['t']('Optimizing data. Please wait...')} ${percentComplete}%` })
      this.syncMessage$.next({ indexing: true, indexingMessage: `${window['t']('Optimizing data. Please wait...')} ${percentComplete}%` })
    })
    for (let view of viewsToOptimize) {
      console.log(`Indexing: ${view}`)
      try {
        await db.query(view, { limit: 1 })
      } catch(e) {
        console.log(e)
        console.warn(`Error indexing ${view}`)
      }
      i++
    }
    this.syncMessage$.next({ syncMessage: `` })
    this.syncMessage$.next({ indexing: false, indexingMessage: `` })
  }

  async createSyncFormIndex(username:string = '') {
    let db
    if (!username) {
      db = await this.userService.getUserDatabase()
    } else {
      db = await this.userService.getUserDatabase(username)
    }
    // const formsInfo = await this.formsInfoService.getFormsInfo()
    const formsInfo = await this.tangyFormsInfoService.getFormsInfo()
    await createSyncFormIndex(db, formsInfo)
  }

  /**
   * Downloads doc id's from local and remote, compares them and creates an array of doc_ids.
   * Replicates to target using those doc_ids.
   * Sends replicationstatus
   * Indexes views.
   * @param direction
   */
  async compareDocs(direction: string, reduceBatchSize = false):Promise<ReplicationStatus> {
    
    let status = <ReplicationStatus>{
      pulled: 0,
      pullConflicts: [],
      info: '',
      remaining: 0,
      direction: ''
    }
    
    const appConfig = await this.appConfigService.getAppConfig()
    this.batchSize = reduceBatchSize ? this.reducedBatchSize : appConfig.batchSize || this.batchSize
    this.writeBatchSize = reduceBatchSize ? this.reducedWriteBatchSize : appConfig.writeBatchSize || this.writeBatchSize
    this.compareLimit = reduceBatchSize ? this.reducedCompareLimit : appConfig.compareLimit || this.compareLimit

    const device = await this.deviceService.getDevice()
    let userDb: UserDatabase = await this.userService.getUserDatabase()

    this.compareDocsStartTime = new Date().toISOString()

    const formInfos = await this.tangyFormsInfoService.getFormsInfo()
    
    const syncDetails: SyncCouchdbDetails = <SyncCouchdbDetails>{
      serverUrl: appConfig.serverUrl,
      groupId: appConfig.groupId,
      deviceId: device._id,
      deviceToken: device.token,
      formInfos:formInfos,
      deviceSyncLocations: device.syncLocations,
    }

    const syncSessionUrl = await this.http.get(`${syncDetails.serverUrl}sync-session/start/${syncDetails.groupId}/${syncDetails.deviceId}/${syncDetails.deviceToken}`, {responseType: 'text'}).toPromise()
    const remoteDb = new PouchDB(syncSessionUrl)
    const pushOptions = {limit: this.compareLimit}
    const localDocs = await this.pageThroughAlldocsOrSelector(userDb.db, pushOptions, "local device");
    const pullSelector = this.syncCouchdbService.getPullSelector(syncDetails);
    const pullOptions = {
      limit: this.compareLimit,
      selector: pullSelector,
      fields: ["_id"]
    }
    const remoteDocs = await this.pageThroughAlldocsOrSelector(remoteDb, pullOptions, "server");
    // remove the initial user-profile - is not uploaded to server
    const userProfiles = await this.tangyFormService.getResponsesByFormId('user-profile')
    const initialProfile = userProfiles.find(profile => Object.keys(profile.location).length === 0)
    if (initialProfile) {
      // const index = localDocs.indexOf(initialProfile._id);
      const index = localDocs.findIndex(doc => doc.id == initialProfile._id)
      if (index > -1) {
        localDocs.splice(index, 1);
      }
    }
    console.log("localDocs: " + localDocs.length + " remoteDocs: " + remoteDocs.length)
    this.syncMessage$.next({
      message: window['t']("Direction: " + direction + ". Now calculating documents to sync with the server. Docs in local tablet: " + localDocs.length + " Docs on server: " + remoteDocs.length)
    })
    let i=0, idsToSync = [], sourceDocs, targetDocs, sourceDocIdentifier, targetDocIdentifier, replicationFunction, syncOptions
    if (direction === 'push') {
      sourceDocs = localDocs
      sourceDocIdentifier = 'id'
      targetDocs = remoteDocs
      targetDocIdentifier = '_id'
      replicationFunction = this.syncCouchdbService._push
    } else if (direction === 'pull'){
      sourceDocs = remoteDocs
      sourceDocIdentifier = '_id'
      targetDocs = localDocs
      targetDocIdentifier = 'id'
      replicationFunction = this.syncCouchdbService._pull
    }
    sourceDocs.forEach(sourceDoc => {
      // if we really wanted to, we could add _rev to the fields provided by the remote mango query 
      // and then compare to localDoc.value.rev
      if (!targetDocs.some(targetDoc => targetDoc[targetDocIdentifier] === sourceDoc[sourceDocIdentifier])) {
        if (!sourceDoc[sourceDocIdentifier].includes('_design')) {
          idsToSync.push(sourceDoc[sourceDocIdentifier])
        }
      }
      i++
      if (i % 50 == 0) {
        this.syncMessage$.next({
          message: window['t']("Compared " + i + " docs out of: " + localDocs.length)
        })
      }
    })
    if (idsToSync.length > 0) {
      this.syncMessage$.next({
        message: window['t']("There are  " + idsToSync.length + " docs to sync. ")
      })

      let pushed = 0, pulled = 0
      let pushSyncOptions = {
        "batch_size": this.batchSize,
        "batches_limit": 1,
        "remaining": 100,
        "pushed": pushed,
        "doc_ids": idsToSync
      }
      let pullSyncOptions = {
        "batch_size": this.batchSize,
        "write_batch_size": this.writeBatchSize,
        "batches_limit": 1,
        "pulled": pulled,
        "doc_ids": idsToSync
      }
      if (direction === 'push') {
        syncOptions = pushSyncOptions
      } else {
        syncOptions = pullSyncOptions
      }

      try {
        status = <ReplicationStatus>await replicationFunction(userDb, remoteDb, syncOptions);
        if (typeof status.pushed !== 'undefined') {
          pushed = pushed + status.pushed
          status.pushed = pushed
        } else {
          status.pushed = pushed
        }
        if (typeof status.pulled !== 'undefined') {
          pulled = pulled + status.pulled
          status.pulled = pulled
        } else {
          status.pulled = pulled
        }
        this.syncMessage$.next(status)
      } catch (e) {
        console.log("Error: " + e)
      }
    } else {
      status.pushed = 0
      this.syncMessage$.next({
        message: window['t']("There are no docs to sync. ")
      })
    }

    this.replicationStatus = status
    
    // Prepare replicationstatus report for the server.
    try {
      this.replicationStatus.compareDocsStartTime = this.compareDocsStartTime
      this.replicationStatus.compareDocsDirection = direction
      if (appConfig.calculateLocalDocsForLocation) {
        const formInfos = await this.tangyFormsInfoService.getFormsInfo()
        let formStats = await this.calculateLocalDocsForLocation(appConfig, userDb, formInfos);
        this.replicationStatus.localDocsForLocation = formStats
      }
      this.replicationStatus.compareDocsEndTime = new Date().toISOString()
      const start = moment(this.replicationStatus.compareDocsStartTime)
      const end = moment(this.replicationStatus.compareDocsEndTime)
      const diff = end.diff(start)
      const duration = moment.duration(diff).as('milliseconds')
      this.replicationStatus.localDocsCount = localDocs.length
      this.replicationStatus.remoteDocsCount = remoteDocs.length
      this.replicationStatus.idsToSyncCount = idsToSync.length
      this.replicationStatus.compareSyncDuration = duration
      await this.addDeviceSyncMetadata()
      
      this.syncMessage$.next({
        message: window['t']('Sending sync status to server. Please wait...')
      })
      await this.deviceService.didSync(status)
    } catch (e) {
      this.syncMessage$.next({message: window['t']('Error sending sync status to server: ' + e)})
      console.log("Error: " + e)
    }

    if (!appConfig.indexViewsOnlyOnFirstSync) {
      this.syncMessage$.next({
        message: window['t']('Optimizing data. This may take several minutes. Please wait...'),
        remaining: null
      })
      await this.indexViews(null)
    }
    
    return status
  }

  /**
   * Returns an array of docs using either an allDocs or find query. 
   * Using the alternate startkey pagination method: https://docs.couchdb.org/en/latest/ddocs/views/pagination.html#paging-alternate-method
   * 
   * @param database
   * @param options
   * @param dbName
   */
  async pageThroughAlldocsOrSelector(database: PouchDB, options, dbName) {
    let allDocs = []
    let remaining = true
    let total_rows = 0
    // Reset startkey if it was set in previous function call.
    delete options.startkey
    let queryFunction = "allDocs"
    let responseArrayName = "rows"
    let pagerKeyName = "startkey"
    if (options.selector) {
      queryFunction = "find"
      responseArrayName = "docs"
      pagerKeyName = "bookmark"
    }
    while (remaining === true) {
      try {
        const response = await database[queryFunction](options)
        if (response && response[responseArrayName].length > 0) {
          if (options.selector) {
            const pagerKey = response[pagerKeyName]
            allDocs.push(...response[responseArrayName])
            options[pagerKeyName] = pagerKey
          } else {
            total_rows = response.total_rows
            const responseLength = response[responseArrayName].length
            const pagerKey = response[responseArrayName][responseLength - 1].id
            // Remove the last item (to be used as pagerKey) and add to the allDocs array
            allDocs.push(...response[responseArrayName].splice(0, responseLength - 1))
            if (responseLength === 1 && pagerKey === options[pagerKeyName]) {
              allDocs.push(response[responseArrayName][0])
              remaining = false
            } else {
              options[pagerKeyName] = pagerKey
            }
          }
          
          let message = 'Collected ' + allDocs.length + ' out of ' + total_rows + ' docs from the ' + dbName + ' for comparison.';
          if (options.selector) {
            message = 'Collected ' + allDocs.length + ' docs from the ' + dbName + ' for comparison.';
          }
          this.syncMessage$.next({
            message: window['t'](message)
          })
        } else {
          remaining = false
        }
      } catch (e) {
        console.log("Error getting allDocs: " + e)
      }
    }
    console.log("total_rows: " + total_rows)
    return allDocs;
  }

  /**
   * Delete docs with 'archived:true'
   * Using initialPullLastSeq, which is accessed before sync starts.
   */
  async deleteArchivedDocs(db: PouchDB, initialPushLastSeq: string) {
    let deletedArchivedDocs = 0
    if (initialPushLastSeq) {
      // TODO: do we need the limit flag?
      const changes = await db.changes({ since: initialPushLastSeq, include_docs: false })
      if (changes.results.length > 0) {
        for (let change of changes.results) {
          try {
            const doc = await db.get(change.id)
            if (doc && doc.archived) {
              await db.remove(doc)
              deletedArchivedDocs++
            }
          } catch (error) {
            // Don't log - probably could not get a doc that was deleted already.
          }
        }
      }
    }
    return deletedArchivedDocs
  }
  
}
