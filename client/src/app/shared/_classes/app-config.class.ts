export class AppConfig {

  // 
  // Tangerine Flavor
  //

  // The homeUrl determines which Tangerine Flavor. Options are as follows.
  //
  // Tangerine Coach: 'case-management'
  // Tangerine Case Management: 'case-home'
  // Tangerine Teach: 'dashboard'
  homeUrl = "case-management"

  //
  // i18n configuration.
  //

  languageDirection  = "ltr"
  languageCode = "en"
  useEthiopianCalendar:boolean
  // Format of the date to be displayed in the application. Use Moment's Format standard. https://momentjs.com/docs/#/displaying/format/
  dateFormat = "M/D/YYYY"

  //
  // Sync configuration
  // 

  serverUrl = "http://localhost/"
  syncProtocol = '1'
  groupId:string
  groupName:string
 
  //
  // Sync Protocol 1 configuration.
  //

  uploadToken = "change_this_token"
  uploadUrl = ''
  uploadUnlockedFormReponses = false
  usageCleanupBatchSize
  minimumFreeSpace

  //
  // Sync Protocol 2 configuration.
  //

  // In a sync batch, control the number of database records read, sent over the network, and written to the database. Tweak this down when using the SqlCipher encryption plugin to avoid database crashes.
  batchSize:number
  // On a Devices first sync. Control in a batch the number of database records read, sent over the network, and written to the database. Tweak this down when using the SqlCipher encryption plugin to avoid database crashes.
  initialBatchSize:number
  // The max number of documents that will get written to disk during a sync. Tweak this down when using the SqlCipher encryption plugin to avoid database crashes.
  writeBatchSize:number
  // The max number of documents that will indexed at a time. Tweak this down when using the SqlCipher encryption plugin to avoid database crashes.
  changesBatchSize:number
  // The number of IDs to read from the database at a time when doing a Comparison Sync.
  compareLimit: number;
  // List of views to skip optimization of after a sync.
  doNotOptimize: Array<string>
  // Prevent database optimization after a sync other than the first sync. This is not recommended, will lead to performance issues when using Devices.
  indexViewsOnlyOnFirstSync:boolean = false
  // Enables support for reducing the number of documents processed in the changed feed when syncing by passing this value to pouchDBOptions used when instantiating a db connection in db.factory.ts. This setting can help sites that experience crashes when syncing or indexing documents. Using this setting *will* slow sync times. (default: 50) 
  changes_batch_size:number
 
  //
  // Account auth configuration.
  //

  listUsernamesOnLoginScreen = true
  securityQuestionText = "What is your year of birth?"
  // Regex used to validate passwords for Device accounts.
  passwordPolicy:string
  // Description of validation for passwords of Device accounts.
  passwordRecipe:string
  // Disregard password functionality.
  noPassword = false
  // Prevent users from logging out and accessing menu. Useful when used in conjunction with a kiosk mode app.
  kioskMode = false
  // How many clicks to exit kioskMode?
  exitClicks:number

  //
  // Profile configuration.
  //

  // centrallyManagedUserProfile and registrationRequiresServerUser are mutually exclusive. If both are set to true, the app will default to using centrallyManagedUserProfile.
  // The user profile is managed by the server and not the Device. This setting is only applicable to Sync Protocol 1.
  centrallyManagedUserProfile = false
  // The user profile is initially managed by the server and can be updated on the client. This setting is only applicable to Sync Protocol 2.
  registrationRequiresServerUser = false
  // Hides the user profile link to edit when on the Device.
  hideProfile = false
  // Hides the about page.
  hideAbout = false
  // When using Sync Protocol 2 and associating a new Device Account with a Device User, setting this to true will show them all Device Users synced
  // down to the Device rather than filtering those Device Users based on the single Device Assignment.
  disableDeviceUserFilteringByAssignment:boolean

  //
  // Encryption configuration.
  //

  // Options are "SqlCipher" or "CryptoPouch". "SqlCipher" is the default but "CryptoPouch" is probably more stable.
  encryptionPlugin:EncryptionPlugin
  // Turns off all app level encryption. App will then report as depending on System (disk) level encryption.
  turnOffAppLevelEncryption:boolean

  //
  // GPS configuration.
  //

  // Don't collect much GPS data and want to save battery? Set this to true to prevent the GPS chip from running constantly.
  disableGpsWarming:boolean

  //
  // Tangerine Case module configuration.
  //

  showQueries:boolean
  showCaseReports:boolean
  // Determines wether or not the Issues tab is shown on the case module's home screen.
  showIssues:boolean
  barcodeSearchMapFunction:string
  // Determines if a "Create Issue" button appears when viewing submitted Event Forms.
  allowCreationOfIssues:boolean
  // Determines if a "Merge Issue" button appears in the Issues Revision page.
  allowMergeOfIssues:boolean
  filterCaseEventScheduleByDeviceAssignedLocation:boolean = false


  //
  // Tangerine Coach configuration.
  //

  columnsOnVisitsTab = []
  categories = []
  
  //
  // Teach configuration properties
  //

  teachProperties = {
    units: [],
    unitDates: [],
    cutoffRange:10,
    attendancePrimaryThreshold: 80,
    attendanceSecondaryThreshold: 70,
    scoringPrimaryThreshold: 70,
    scoringSecondaryThreshold: 60,
    behaviorPrimaryThreshold: 90,
    behaviorSecondaryThreshold: 80,
    useAttendanceFeature: false,
    showAttendanceCalendar: false,
    studentRegistrationFields:[]
  }

  //
  // Custom App configuration
  //

  goHomeAfterFormSubmit = false
  forceCompleteForms = false

  //
  // Backup configuration.
  //

  useCachedDbDumps:boolean
  dbBackupSplitNumberFiles: number;
  
  // Media files configuration
  mediaFileStorageLocation:string  // Options: 'database' (default) or 'file'. If undefined, will save to database.

  //
  // Experimental configuration.
  //

  // Use experimental mode in Tangy Form that only captures the properties of inputs that have changed from their original state in the form.
  saveLessFormData:boolean
  p2pSync = 'false'
  attachHistoryToDocs:boolean = false
  usePouchDbLastSequenceTracking:boolean
  forceNewEventFormConfirmation:boolean = false

  //
  // @TODO Sort these.
  //

  calculateLocalDocsForLocation:boolean;
  
}

export enum EncryptionPlugin {
  SqlCipher = 'SqlCipher',
  CryptoPouch = 'CryptoPouch'
}
