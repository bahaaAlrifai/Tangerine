import { NotificationStatus } from './../../classes/notification.class';
import { EventFormDefinition } from './../../classes/event-form-definition.class';

import { Component, OnInit, EventEmitter, ChangeDetectorRef, Input, Output } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CaseService } from '../../services/case.service'
import { CaseEvent } from '../../classes/case-event.class'
import { CaseEventDefinition } from '../../classes/case-event-definition.class';
import { EventForm } from '../../classes/event-form.class';

interface EventFormInfo {
  eventFormDefinition:EventFormDefinition
  eventForm:EventForm
}

interface ParticipantInfo {
  id: string
  renderedListItem:string
  newFormLink:string
  eventFormsParticipantCanCreate: Array<string>
  caseEventHasEventFormsForParticipantsRole:boolean
  eventFormInfos: Array<EventFormInfo>
}

@Component({
  selector: 'app-event-forms-for-participant',
  templateUrl: './event-forms-for-participant.component.html',
  styleUrls: ['./event-forms-for-participant.component.css']
})
export class EventFormsForParticipantComponent implements OnInit {

  @Input('participantId') participantId:string
  @Input('caseId') caseId:string
  @Input('eventId') eventId:string
  @Input('showArchived') showArchived: boolean;
  @Output() formDeletedEvent = new EventEmitter();
  @Output() formArchivedEvent = new EventEmitter();
  @Output() formUnarchivedEvent = new EventEmitter();

  caseEvent:CaseEvent
  caseEventDefinition: CaseEventDefinition
  participantInfos:Array<ParticipantInfo>
  participantInfo:ParticipantInfo
  noRoleEventFormInfos: Array<EventFormInfo>
  loaded = false
  availableEventFormDefinitions:Array<EventFormDefinition> = []
  selectedNewEventFormDefinition = ''
  hasNotificationEnforcingAttention = false
  _canExitToRoute = []
  window:any

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private caseService: CaseService,
    private ref: ChangeDetectorRef
  ) {
    ref.detach()
    this.window = window
  }

  ngOnInit() {
    this.render()
  }

  async render() {
    await this.caseService.load(this.caseId)
    this.window.caseService = this.caseService
    this.caseEvent = this
      .caseService
      .case
      .events
      .find(caseEvent => caseEvent.id === this.eventId)
    this.caseEventDefinition = this
      .caseService
      .caseDefinition
      .eventDefinitions
      .find(caseDef => caseDef.id === this.caseEvent.caseEventDefinitionId)
    this.getParticipantInfo()
    this.loaded = true
    this.ref.detectChanges()
  }

  exitRoutes() {
    return this._canExitToRoute
  }

  onDeleteFormClick(eventFormId) {
    this.formDeletedEvent.emit(eventFormId);
  }

  onArchiveFormClick(eventFormId) {
    this.formArchivedEvent.emit(eventFormId);
  }

  onUnarchiveFormClick(eventFormId) {
    this.formUnarchivedEvent.emit(eventFormId);
  }

  eventFormsParticipantCanCreate(participantId) {
    const participant = this.caseService.case.participants.find(participant => participant.id === participantId)
    return this.caseEventDefinition.eventFormDefinitions
      .filter(eventFormDefinition => eventFormDefinition.forCaseRole.split(',').map(e=>e.trim()).includes(participant.caseRoleId))
      .reduce((availableEventFormDefinitions, eventFormDefinition) => {
        const eventFormDefinitionHasForm = this.caseEvent.eventForms
          .filter(eventForm => eventForm.participantId === participantId)
          .reduce((eventFormDefinitionHasForm, form) => {
            return eventFormDefinitionHasForm || form.eventFormDefinitionId === eventFormDefinition.id
          }, false)
        return eventFormDefinition.repeatable || !eventFormDefinitionHasForm
          ? [...availableEventFormDefinitions, eventFormDefinition]
          : availableEventFormDefinitions
      }, [])
  }

  getParticipantInfo() {
    const participant = this.caseService.case.participants.find(participant => participant.id === this.participantId)
    const id = participant.id
    const data = participant.data
    const role = this.caseService.caseDefinition.caseRoles.find(caseRole => caseRole.id === participant.caseRoleId)
    let renderedListItem:string
    eval(`renderedListItem = \`${role.templateListItem}\``)
    const participantInfo = <ParticipantInfo>{
      id,
      renderedListItem,
      newFormLink: `/case/event/form-add/${this.caseService.case._id}/${this.caseEvent.id}/${participant.id}`,
      caseEventHasEventFormsForParticipantsRole: this.caseEventDefinition.eventFormDefinitions.some(eventDef => eventDef.forCaseRole.split(',').map(e=>e.trim()).includes(participant.caseRoleId)),
      eventFormsParticipantCanCreate: this.eventFormsParticipantCanCreate(participant.id),
      eventFormInfos: this.caseEvent.eventForms.reduce((eventFormInfos, eventForm) => {
        return (eventForm.participantId === participant.id && (this.showArchived || !eventForm.archived))
          ? [...eventFormInfos, <EventFormInfo>{
            eventForm,
            eventFormDefinition: this
              .caseEventDefinition
              .eventFormDefinitions
              .find(eventFormDefinition => eventFormDefinition.id === eventForm.eventFormDefinitionId)
          }]
          : eventFormInfos
      }, [])
    }
    this.participantInfo = participantInfo
  }

}
