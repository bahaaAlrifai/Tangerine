import { _TRANSLATE } from 'src/app/shared/translation-marker';
import { LocationConfig } from './../device/classes/device.class';
import {HttpClient, HttpResponse} from '@angular/common/http';
import { ReplicationStatus } from './classes/replication-status.class';
import { FormInfo } from 'src/app/tangy-forms/classes/form-info.class';
import { UserDatabase } from './../shared/_classes/user-database.class';
import { Injectable } from '@angular/core';
import PouchDB from 'pouchdb'
import {Subject} from 'rxjs';
import {VariableService} from '../shared/_services/variable.service';
import {AppConfigService} from '../shared/_services/app-config.service';
import { AppContext } from '../app-context.enum';
import {CaseDefinition} from "../case/classes/case-definition.class";
import {CaseDefinitionsService} from "../case/services/case-definitions.service";
import {CaseService} from "../case/services/case.service";
import {TangyFormService} from "../tangy-forms/tangy-form.service";
import { SyncDirection } from './sync-direction.enum';
import { UserService } from '../shared/_services/user.service';
import { DeviceService } from '../device/services/device.service';

const sleep = (milliseconds) => new Promise((res) => setTimeout(() => res(true), milliseconds))
const retryDelay = 5*1000

export interface LocationQuery {
  level:string
  id:string
}

export class SyncCouchdbDetails {
  serverUrl:string
  groupId:string
  deviceId:string
  deviceToken:string
  usePouchDbLastSequenceTracking:boolean
  formInfos:Array<FormInfo> = []
  locationQueries:Array<LocationQuery> = []
  deviceSyncLocations:Array<LocationConfig>
  disableDeviceUserFilteringByAssignment:boolean
}

export class SyncSessionInfo {
  syncSessionUrl:string
  deviceSyncLocations:Array<LocationConfig> 
}

function syncLocationsDontMatch(locationConfigA:LocationConfig, locationConfigB:LocationConfig) {
  const lowestANode = locationConfigA.value[locationConfigA.value.length-1]
  const lowestBNode = locationConfigA.value[locationConfigA.value.length-1]
  return lowestANode.value !== lowestBNode.value
    ? true
    : false
}

function syncLocationConfigsDontMatch(a:Array<LocationConfig>, b:Array<LocationConfig>) {
  let syncLocationConfigsDontMatch = false
  for (let locationConfigA of a) {
    // If there isn't at least one matching sync location, then sync locations don't match.
    if (b.some(locationConfigB => syncLocationsDontMatch(locationConfigB, locationConfigA))) {
      syncLocationConfigsDontMatch = true
    }
  }
  // And now the same, but the other way around.
  for (let locationConfigB of b) {
    // If there isn't at least one matching sync location, then sync locations don't match.
    if (a.some(locationConfigA => syncLocationsDontMatch(locationConfigB, locationConfigA))) {
      syncLocationConfigsDontMatch = true
    }
  }
  return syncLocationConfigsDontMatch
} 

@Injectable({
  providedIn: 'root'
})
export class SyncCouchdbService {

  public readonly syncMessage$: Subject<any> = new Subject();
  public readonly onCancelled$: Subject<any> = new Subject();
  cancelling = false
  syncing = false 
  batchSize = 200
  initialBatchSize = 1000
  writeBatchSize = 50
  changesBatchSize = 25
  reducedBatchSize = 10
  reducedWriteBatchSize = 10
  reducedChangesBatchSize = 1
  pullSyncOptions;
  pushSyncOptions;
  fullSync: string;
  retryCount: number
  
  constructor(
    private http: HttpClient,
    private variableService: VariableService,
    private appConfigService: AppConfigService,
    private caseDefinitionsService: CaseDefinitionsService,
    private caseService: CaseService,
    private userService: UserService,
    private deviceService: DeviceService,
    private tangyFormService: TangyFormService
  ) { }

  cancel() {
    this.cancelling = true
  }

  finishCancelling(replicationStatus:ReplicationStatus) {
    this.cancelling = false
    this.onCancelled$.next({
      ...replicationStatus,
      cancelled: true
    })
  }

  /**
   * Note that if you run this with no forms configured to CouchDB sync,
   * that will result in no filter query and everything will be synced. Use carefully.
   * @param userDb
   * @param syncDetails
   * @param caseDefinitions - null if not testing.
   */
  async sync(
    userDb:UserDatabase,
    syncDetails:SyncCouchdbDetails,
    caseDefinitions:CaseDefinition[] = null,
    isFirstSync = false,
    fullSync?:SyncDirection,
    reduceBatchSize = false
  ): Promise<ReplicationStatus> {
    // set fullSync
    this.fullSync = fullSync
    // Prepare config.
    const appConfig = await this.appConfigService.getAppConfig()
    this.batchSize =
      (isFirstSync || fullSync === SyncDirection.pull) ? this.initialBatchSize :
      reduceBatchSize ? this.reducedBatchSize : appConfig.batchSize || this.batchSize
    this.writeBatchSize = reduceBatchSize ? this.reducedBatchSize : appConfig.writeBatchSize || this.writeBatchSize
    this.changesBatchSize = reduceBatchSize ? this.reducedChangesBatchSize : appConfig.changesBatchSize || this.changesBatchSize

    let replicationStatus:ReplicationStatus
    syncDetails.usePouchDbLastSequenceTracking = appConfig.usePouchDbLastSequenceTracking || await this.variableService.get('usePouchDbLastSequenceTracking')
      ? true
      : false
    // Create sync session and instantiate remote database connection.
    let remoteDb
    try {
      const syncSessionInfo = <SyncSessionInfo>await this.http.get(`${syncDetails.serverUrl}sync-session-v2/start/${syncDetails.groupId}/${syncDetails.deviceId}/${syncDetails.deviceToken}`).toPromise()
      syncDetails.deviceSyncLocations = syncSessionInfo.deviceSyncLocations
      remoteDb = new PouchDB(syncSessionInfo.syncSessionUrl)
    } catch (e) {
      replicationStatus = {
        ...replicationStatus,
        pushError: `${_TRANSLATE('Please retry sync. Are you connected to the Internet?')}`
      }
      this.syncMessage$.next(replicationStatus)
      return replicationStatus
    }

    if (this.cancelling) {
      this.finishCancelling(replicationStatus)
      return replicationStatus
    }

    // Push.
    let pushReplicationStatus
    let hadPushSuccess = false
    this.retryCount = 1
    if (!isFirstSync) {
      let docs_written = 0
      while (!hadPushSuccess && !this.cancelling) {
        pushReplicationStatus = await this.push(userDb, remoteDb, appConfig, syncDetails);
        if (
          !pushReplicationStatus.pushError &&
          pushReplicationStatus.info.docs_written === 0 &&
          pushReplicationStatus.info.doc_write_failures === 0
        ) {
          hadPushSuccess = true
          pushReplicationStatus.hadPushSuccess = true
          await this.variableService.set('sync-push-last_seq', pushReplicationStatus.info.last_seq)
        } else if (pushReplicationStatus.pushError || pushReplicationStatus.info.doc_write_failures > 0) {
          docs_written += pushReplicationStatus.info.docs_written
          await sleep(retryDelay)
          ++this.retryCount
        } else {
          docs_written += pushReplicationStatus.info.docs_written
          ++this.retryCount
        }
      }
      pushReplicationStatus.info.docs_written = docs_written
      pushReplicationStatus.pushed = docs_written
      replicationStatus = {...replicationStatus, ...pushReplicationStatus}
      this.syncMessage$.next(replicationStatus);
    }

    if (this.cancelling) {
      this.finishCancelling(replicationStatus)
      return replicationStatus
    }

    // Sync Locations Change Detection. 
    const previousDeviceSyncLocations = await this.variableService.get('previousDeviceSyncLocations')
    const syncLocationsDontMatchVar = previousDeviceSyncLocations ? syncLocationConfigsDontMatch(syncDetails.deviceSyncLocations, previousDeviceSyncLocations) : true
    if (!isFirstSync && syncLocationsDontMatchVar) {
      this.fullSync = 'push'
      this.retryCount = 1
      while (!hadPushSuccess && !this.cancelling) {
        pushReplicationStatus = await this.push(userDb, remoteDb, appConfig, syncDetails);
        if (!pushReplicationStatus.pushError) {
          hadPushSuccess = true
          pushReplicationStatus.hadPushSuccess = true
        } else {
          await sleep(retryDelay)
          ++this.retryCount
        }
      }
      replicationStatus = {...replicationStatus, ...pushReplicationStatus}
      this.syncMessage$.next(replicationStatus);
      
      const device = await this.deviceService.getDevice()
      await this.userService.reinstallSharedUserDatabase(device)
      // Refresh db connection.
      userDb = await this.userService.getUserDatabase()
      await this.variableService.set('previousDeviceSyncLocations', syncDetails.deviceSyncLocations)
      await this.variableService.set('sync-pull-last_seq', 0)
   }
    if (isFirstSync) {
      await this.variableService.set('previousDeviceSyncLocations', syncDetails.deviceSyncLocations)
    }

    // Pull.
    let pullReplicationStatus
    let hadPullSuccess = false
    this.retryCount = 1
    let prePullLastSeq = await this.variableService.get('sync-pull-last_seq')
    while (!hadPullSuccess && !this.cancelling) {
      try {
        pullReplicationStatus = await this.pull(userDb, remoteDb, syncDetails, prePullLastSeq);
        if (!pullReplicationStatus.pullError) {
          await this.variableService.set('sync-pull-last_seq', pullReplicationStatus.info.last_seq)
          hadPullSuccess = true
          pullReplicationStatus.hadPullSuccess = true
        } else {
          await sleep(retryDelay)
          ++this.retryCount
        }
      } catch (e) {
        // Theoretically this.pull shouldn't ever throw an error, but just in case make sure we set that last push sequence.
        const localSequenceAfterPull = (await userDb.changes({descending: true, limit: 1})).last_seq
        await this.variableService.set('sync-push-last_seq', localSequenceAfterPull)
        console.error(e)
        await sleep(retryDelay)
      }
    }
    replicationStatus = {...replicationStatus, ...pullReplicationStatus}
    this.syncMessage$.next(replicationStatus);

    // Pull Form Response Ids Assigned to the Device
    // get the list of docs assigned to the device from the server device database
    const deviceDoc = await this.deviceService.getRemoteDeviceInfo(syncDetails.deviceId, syncDetails.deviceToken)
    const assignedFormResponseIds = deviceDoc?.assignedFormResponseIds ? deviceDoc.assignedFormResponseIds : []

    let pullIssueFormsReplicationStatus
    let hadPullIssueFormsSuccess = false
    while (!hadPullIssueFormsSuccess && !this.cancelling) {
      try {
        pullIssueFormsReplicationStatus = await this.pullFormResponses(userDb, remoteDb, assignedFormResponseIds, syncDetails, prePullLastSeq);
        if (!pullIssueFormsReplicationStatus.pullError) {
          hadPullIssueFormsSuccess = true
          pullIssueFormsReplicationStatus.hadPullSuccess = true
        } else {
          await sleep(retryDelay)
          ++this.retryCount
        }
      } catch (e) {
        console.error(e)
        await sleep(retryDelay)
      }
    }
    replicationStatus = {...replicationStatus, ...pullIssueFormsReplicationStatus}
    this.syncMessage$.next(replicationStatus);

    if (this.cancelling) {
      this.finishCancelling(replicationStatus)
    }

    // All done.
    return replicationStatus
  }

  _push (userDb, remoteDb, syncOptions) {
    return new Promise( (resolve, reject) => {
      let checkpointProgress = 0, diffingProgress = 0, startBatchProgress = 0, pendingBatchProgress = 0
      const direction = 'push'
      userDb.db['replicate'].to(remoteDb, syncOptions).on('complete', async (info) => {
        const status = <ReplicationStatus>{
          pushed: info.docs_written,
          info: info,
          direction: direction
        }
        if (info.errors && info.errors.length > 0) {
          status.pushError = info.errors.join('; ')
          reject(status)
        } else {
          resolve(status)
        }
      }).on('change', async (info) => {
        const pushed = syncOptions.pushed + info.docs_written
        const progress = {
          'docs_read': info.docs_read,
          'docs_written': info.docs_written,
          'doc_write_failures': info.doc_write_failures,
          'pending': info.pending,
          'direction': direction,
          'last_seq': info.last_seq,
          'pushed': pushed
        };
        this.syncMessage$.next(progress);
      }).on('checkpoint', (info) => {
        if (info) {
          // console.log(direction + ': Checkpoint - Info: ' + JSON.stringify(info));
          let progress;
          if (info.checkpoint) {
            checkpointProgress = checkpointProgress + 1
            progress = {
              'message': checkpointProgress,
              'type': 'checkpoint',
              'direction': direction
            };
          } else if (info.diffing) {
            diffingProgress = diffingProgress + 1
            progress = {
              'message': diffingProgress,
              'type': 'diffing',
              'direction': direction
            };
          } else if (info.startNextBatch) {
            startBatchProgress = startBatchProgress + 1
            progress = {
              'message': startBatchProgress,
              'type': 'startNextBatch',
              'direction': direction
            };
          } else if (info.pendingBatch) {
            pendingBatchProgress = pendingBatchProgress + 1
            progress = {
              'message': pendingBatchProgress,
              'type': 'pendingBatch',
              'direction': direction
            };
          } else {
            progress = {
              'message': JSON.stringify(info),
              'type': 'other',
              'direction': direction
            };
          }
          this.syncMessage$.next(progress);
        } else {
          console.log(direction + ': Calculating Checkpoints.');
        }
      }).on('active', function (info) {
        if (info) {
          console.log('Push replication is active. Info: ' + JSON.stringify(info));
        } else {
          console.log('Push replication is active.');
        }
      }).on('error', function (error) {
        console.error(error)
        const status = <ReplicationStatus>{
          pushError: "Push failed. error: " + error
        }
        reject(status);
      });
    })
  }
  
  async push(userDb, remoteDb, appConfig, syncDetails): Promise<ReplicationStatus> {
    // Get the sequences we'll be starting with.
    let push_last_seq = await this.variableService.get('sync-push-last_seq')

    if (typeof push_last_seq === 'undefined') {
      push_last_seq = 0;
    }
    if (this.fullSync && this.fullSync === 'push') {
      push_last_seq = 0;
    }

    let progress = {
      'direction': 'push',
      'message': 'About to push any new data to the server.'
    }
    
    this.syncMessage$.next(progress)

    let status = <ReplicationStatus>{
      pushed: 0,
      info: '',
      remaining: 0,
      direction: 'push'
    };
    
    let failureDetected = false
    let pushed = 0
    let syncOptions = {
      ...syncDetails.usePouchDbLastSequenceTracking ? { } : { "since": push_last_seq },
      "batch_size": this.batchSize,
      "batches_limit": 1,
      "changes_batch_size": this.changesBatchSize,
      "remaining": 100,
      "pushed": pushed,
      "checkpoint": 'source',
       "filter": function (doc) {
        return doc._id.substr(0,7) !== '_design';
      }
    }

    syncOptions = this.pushSyncOptions ? this.pushSyncOptions : syncOptions
    let error;
    try {
      status = <ReplicationStatus>await this._push(userDb, remoteDb, syncOptions);
      if (typeof status.pushed !== 'undefined') {
        pushed = pushed + status.pushed
        status.pushed = pushed
      } else {
        status.pushed = pushed
      }
      this.syncMessage$.next(status)
    } catch (statusWithError) {
      status = {
        ...status,
        ...statusWithError
      }
      if (statusWithError.pushError) {
        error = statusWithError.pushError
      }
      failureDetected = true
    }
    
    status.initialPushLastSeq = push_last_seq
    status.currentPushLastSeq = status.info.last_seq

    if (failureDetected) {
      console.error(status)
      status.pushError = `${error.message || error}. ${window['t']('Trying again')}: ${window['t']('Retry ')}${this.retryCount}.`
    }
    this.syncMessage$.next(status)

    return status;
  }

  _pull(userDb, remoteDb, syncOptions):Promise<ReplicationStatus> {
    return new Promise( (resolve, reject) => {
      let checkpointProgress = 0, diffingProgress = 0, startBatchProgress = 0, pendingBatchProgress = 0
      let status = <ReplicationStatus>{
        pulled: 0,
        pullConflicts: [],
        info: '',
        direction: ''
      }
      const direction = 'pull'
      try {
        userDb.db['replicate'].from(remoteDb, syncOptions).on('complete', async (info) => {
          // console.log("info.last_seq: " + info.last_seq)
          status = <ReplicationStatus>{
            pulled: info.docs_written,
            info: info,
            direction: direction
          }
          // TODO: Should we always resolve or if there is an errors property in the info doc should we reject?
          // If that is the case - we may need to make sure the sync-pull-last-seq is not set.
          resolve(status)
        }).on('change', async (info) => {
          const pulled = syncOptions.pulled + info.docs_written
          const progress = {
            'docs_read': info.docs_read,
            'docs_written': info.docs_written,
            'doc_write_failures': info.doc_write_failures,
            'pending': info.pending,
            'direction': 'pull',
            'last_seq': info.last_seq,
            'pulled': pulled
          }
          await this.variableService.set('sync-pull-last_seq', info.last_seq)
          this.syncMessage$.next(progress)
        }).on('checkpoint', (info) => {
          if (info) {
            // console.log(direction + ': Checkpoint - Info: ' + JSON.stringify(info));
            let progress;
            if (info.checkpoint) {
              checkpointProgress = checkpointProgress + 1
              progress = {
                'message': checkpointProgress,
                'type': 'checkpoint',
                'direction': direction
              };
            } else if (info.diffing) {
              diffingProgress = diffingProgress + 1
              progress = {
                'message': diffingProgress,
                'type': 'diffing',
                'direction': direction
              };
            } else if (info.startNextBatch) {
              startBatchProgress = startBatchProgress + 1
              progress = {
                'message': startBatchProgress,
                'type': 'startNextBatch',
                'direction': direction
              };
            } else if (info.pendingBatch) {
              pendingBatchProgress = pendingBatchProgress + 1
              progress = {
                'message': pendingBatchProgress,
                'type': 'pendingBatch',
                'direction': direction
              };
            }
            this.syncMessage$.next(progress);
          } else {
            console.log(direction + ': Calculating Checkpoints.');
          }
        }).on('error', function (error) {
          reject(error)
        });
      } catch (e) {
        console.log("Error replicating: " + e)
      }
    })
  }

  async pull(userDb, remoteDb, syncDetails, prePullLastSeq): Promise<ReplicationStatus> {
    let status = <ReplicationStatus>{
      pulled: 0,
      pullError: '',
      pullConflicts: [],
      info: '',
      remaining: 0,
      direction: 'pull' 
    };
    if (typeof prePullLastSeq === 'undefined') {
      prePullLastSeq = 0;
    }
    if (this.fullSync && this.fullSync === 'pull') {
      prePullLastSeq = 0;
    }
    const pullSelector = this.getPullSelector(syncDetails);
    let progress = {
      'direction': 'pull',
      'message': 'Received data from remote server.'
    }
    this.syncMessage$.next(progress)
    let failureDetected = false
    let error;
    let pulled = 0
    
    /**
     * The sync option batches_limit is set to 1 in order to reduce the memory load on the tablet. 
     * From the pouchdb API doc:      
     * "Number of batches to process at a time. Defaults to 10. This (along wtih batch_size) controls how many docs 
     * are kept in memory at a time, so the maximum docs in memory at once would equal batch_size × batches_limit."
     */
    let syncOptions = {
      ...syncDetails.usePouchDbLastSequenceTracking ? { } : { "since": prePullLastSeq },
      "batch_size": this.batchSize,
      "write_batch_size": this.writeBatchSize,
      "batches_limit": 1,
      "pulled": pulled,
      "selector": pullSelector,
      "checkpoint": 'target',
      "changes_batch_size": this.changesBatchSize
    }
    
    syncOptions = this.pullSyncOptions ? this.pullSyncOptions : syncOptions
    
    try {
      status = <ReplicationStatus>await this._pull(userDb, remoteDb, syncOptions);
      if (typeof status.pulled !== 'undefined') {
        pulled = pulled + status.pulled
        status.pulled = pulled
      } else {
        status.pulled = pulled
      }
      this.syncMessage$.next(status)
    } catch (e) {
      console.log("Error: " + e)
      failureDetected = true
      error = e
    }
    
    status.initialPullLastSeq = prePullLastSeq
    status.currentPushLastSeq = status.info.last_seq
    status.batchSize = this.batchSize

    if (failureDetected) {
      status.pullError = `${error.message || error}. ${window['t']('Trying again')}: ${window['t']('Retry ')}${this.retryCount}.`
    } 
    
    this.syncMessage$.next(status)
    
    return status;
  }

  getPullSelector(syncDetails:SyncCouchdbDetails) {
    const pullSelector = {
      "$or": [
        ...syncDetails.formInfos.reduce(($or, formInfo) => {
          if (formInfo.couchdbSyncSettings && formInfo.couchdbSyncSettings.enabled && formInfo.couchdbSyncSettings.pull) {
            if (formInfo.id === 'user-profile' && syncDetails.disableDeviceUserFilteringByAssignment) {
              // Replicate all user profiles regardless of location.
              $or = [
                ...$or,
                {
                  'form.id': 'user-profile'
                }
              ]
            } else {
              $or = [
                ...$or,
                ...syncDetails.deviceSyncLocations.length > 0 && formInfo.couchdbSyncSettings.filterByLocation
                  ? syncDetails.deviceSyncLocations.map(locationConfig => {
                    // Get last value, that's the focused sync point.
                    let location = locationConfig.value.slice(-1).pop()
                    return {
                      "form.id": formInfo.id,
                      [`location.${location.level}`]: location.value
                    }
                  })
                  : [
                    {
                      "form.id": formInfo.id
                    }
                  ]
              ]
            }
          }
          return $or
        }, []),
        ...syncDetails.deviceSyncLocations.length > 0
          ? syncDetails.deviceSyncLocations.reduce((filters, locationConfig) => {
            // Get last value, that's the focused sync point.
            let location = locationConfig.value.slice(-1).pop()
            return [
              ...filters,
              {
                "type": "issue",
                [`location.${location.level}`]: location.value,
                "sendToAllDevices": true 
              },
              {
                "type": "issue",
                [`location.${location.level}`]: location.value,
                "sendToDeviceById": syncDetails.deviceId
              }
            ] 
          }, [])
          : [
            {
              "resolveOnAppContext": AppContext.Client,
              "type": "issue"
            }
          ]
      ]
    }
    return pullSelector;
  }

  async pullFormResponses(userDb, remoteDb, docIds, syncDetails, prePullLastSeq): Promise<ReplicationStatus> {
    let status = <ReplicationStatus>{
      pulled: 0,
      pullError: '',
      pullConflicts: [],
      info: '',
      remaining: 0,
      direction: 'pull' 
    };
    if (typeof prePullLastSeq === 'undefined') {
      prePullLastSeq = await this.variableService.get('sync-pull-last_seq')
    }
    if (this.fullSync && this.fullSync === 'pull') {
      prePullLastSeq = await this.variableService.get('sync-pull-last_seq')
    }

    let progress = {
      'direction': 'pull',
      'message': 'Received data from remote server.'
    }
    this.syncMessage$.next(progress)
    let failureDetected = false
    let error;
    let pulled = 0

    /**
     * The sync option batches_limit is set to 1 in order to reduce the memory load on the tablet. 
     * From the pouchdb API doc:      
     * "Number of batches to process at a time. Defaults to 10. This (along wtih batch_size) controls how many docs 
     * are kept in memory at a time, so the maximum docs in memory at once would equal batch_size × batches_limit."
     */
    let syncOptions = {
      ...syncDetails.usePouchDbLastSequenceTracking ? { } : { "since": prePullLastSeq },
      "batch_size": this.batchSize,
      "write_batch_size": this.writeBatchSize,
      "batches_limit": 1,
      "pulled": pulled,
      "doc_ids": docIds,
      "checkpoint": 'target',
      "changes_batch_size": this.changesBatchSize
    }
    syncOptions = this.pullSyncOptions ? this.pullSyncOptions : syncOptions

    try {
      status = <ReplicationStatus>await this._pull(userDb, remoteDb, syncOptions);
      if (typeof status.pulled !== 'undefined') {
        pulled = pulled + status.pulled
        status.pulled = pulled
      } else {
        status.pulled = pulled
      }
      this.syncMessage$.next(status)
    } catch (e) {
      console.log("Error: " + e)
      failureDetected = true
      error = e
    }
    
    status.initialPullLastSeq = prePullLastSeq
    status.currentPushLastSeq = status.info.last_seq
    status.batchSize = this.batchSize

    if (failureDetected) {
      status.pullError = `${error.message || error}. ${window['t']('Trying again')}: ${window['t']('Retry ')}${this.retryCount}.`
    } 
    
    this.syncMessage$.next(status)
    
    return status;
  }
}
