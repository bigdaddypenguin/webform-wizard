import { LightningElement, wire } from 'lwc';
import { loadScript } from 'lightning/platformResourceLoader';
import getConditions from '@salesforce/apex/betterWebformController.getConditions';
import createWebformInstance from '@salesforce/apex/betterWebformController.createWebformInstance';
import createWebformInstanceRecord from '@salesforce/apex/betterWebformController.createWebformInstanceRecord';
import updateWebformInstanceStatus from '@salesforce/apex/betterWebformController.updateWebformInstanceStatus';
import docusignBundle from '@salesforce/resourceUrl/docusign_js';

export default class BetterWebform extends LightningElement {
  // UI state
  showSelector = true;
  groupedConditions = [];
  conditionLookup = {};
  selectedCondition = null;
  selectedConditionId = null;
  isLoading = false;
  errorMessage;

  // DocuSign
  docusignSDK;
  docusignLoaded = false;
  webformsInstance;

  // Instance tracking
  hasRendered = false;
  messageHandler;

  // Web Form identifiers
  instanceToken;
  instanceId;
  currentFormId;
  webformInstanceRecordId;

  // Defer rendering until after created the SF record
  pendingFormUrl = null;
  pendingInstanceToken = null;

  // One-time guards
  _didEnd = false;
  _didSubmit = false;
  _didReady = false;

  // Layout measurements
  _heightRaf = null;
  _lastSelectorHeight = null;
  _boundResizeHandler = null;

  async connectedCallback() {
    if (typeof window !== 'undefined') {
      this._boundResizeHandler = () => this.scheduleSelectorHeightUpdate();
      window.addEventListener('resize', this._boundResizeHandler);
    }

    try {
      console.log('[LWC] Loading DocuSign library');
      await loadScript(this, docusignBundle);
      console.log('[LWC] DocuSign script loaded, initializing SDK');

      // Public webforms: any key works; you just need to call loadDocuSign
      this.docusignSDK = await window.DocuSign.loadDocuSign('WEBFORMS_PUBLIC');
      console.log('[LWC] DocuSign SDK ready:', !!this.docusignSDK);

      this.docusignLoaded = true;
    } catch (error) {
      console.error('[LWC] Error loading DocuSign library:', error);
      this.errorMessage = 'Failed to load DocuSign library: ' + (error?.message || error);
    }
  }

  disconnectedCallback() {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.webformsInstance && typeof this.webformsInstance.destroy === 'function') {
      try { this.webformsInstance.destroy(); } catch (e) { /* noop */ }
    }
    if (this._boundResizeHandler && typeof window !== 'undefined') {
      window.removeEventListener('resize', this._boundResizeHandler);
      this._boundResizeHandler = null;
    }
    if (this._heightRaf && typeof window !== 'undefined') {
      window.cancelAnimationFrame(this._heightRaf);
      this._heightRaf = null;
    }
  }

  renderedCallback() {
    this.scheduleSelectorHeightUpdate();

    if (this.pendingFormUrl && this.pendingInstanceToken && !this.hasRendered && !this.showSelector) {
      this.hasRendered = true;
      const container = this.template.querySelector('[data-id="webform-container"]');
      if (container) {
        console.log('[LWC] Container found, initializing webform');
        this.initializeWebform(container, this.pendingFormUrl, this.pendingInstanceToken);
      } else {
        console.error('[LWC] Container not found in renderedCallback');
      }
    }
  }

  @wire(getConditions)
  wiredConditions({ data, error }) {
    if (data) {
      const lookup = {};
      const grouped = {};

      data.forEach((condition) => {
        lookup[condition.Id] = condition;

        const category = condition.Category__c || 'Other';
        if (!grouped[category]) {
          grouped[category] = [];
        }
        grouped[category].push(condition);
      });

      this.conditionLookup = lookup;
      if (this.selectedConditionId) {
        this.selectedCondition = this.conditionLookup[this.selectedConditionId] || null;
      }

      this.groupedConditions = Object.keys(grouped).map(category => ({
        category,
        conditions: grouped[category]
      }));
    } else if (error) {
      console.error('[LWC] Error loading conditions:', error);
      this.errorMessage = 'Failed to load conditions';
    }
  }

  handleConditionSelect(event) {
    const recordId = event.target?.dataset?.recordid;
    if (!recordId) {
      return;
    }

    const condition = this.conditionLookup?.[recordId];
    if (!condition) {
      console.warn('[LWC] Selected condition not found for Id:', recordId);
      return;
    }

    this.selectedCondition = condition;
    this.selectedConditionId = recordId;
    this.errorMessage = null;
  }

  handleClearSelection() {
    this.selectedCondition = null;
    this.selectedConditionId = null;
  }

  get selectedConditionCategory() {
    if (!this.selectedCondition) {
      return '';
    }
    return this.selectedCondition.Category__c || 'Other';
  }

  get selectedConditionFormId() {
    if (!this.selectedCondition) {
      return '';
    }
    return this.selectedCondition.Form_Id__c || '';
  }

  get selectedConditionPreviewUrl() {
    if (!this.selectedCondition) {
      return '';
    }
    return this.selectedCondition.Webform_URL__c || '';
  }

  async handleStartSelectedCondition() {
    if (!this.selectedCondition) {
      this.errorMessage = 'Select a condition to launch its webform.';
      return;
    }

    if (!this.docusignLoaded) {
      this.errorMessage = 'DocuSign library not loaded yet. Please try again in a moment.';
      return;
    }

    this.isLoading = true;
    this.errorMessage = null;

    const formId = this.selectedCondition.Form_Id__c;
    const dbqWebformId = this.selectedCondition.Id;

    if (!formId || !dbqWebformId) {
      this.errorMessage = 'Missing form information';
      this.isLoading = false;
      return;
    }

    console.log('[LWC] Creating web form instance for form:', formId);

    try {
      // 1) DocuSign: create the instance (Apex makes the REST call)
      const ds = await createWebformInstance({ formId });
      // Expecting: { instanceToken, instanceId, formUrl }
      console.log('[LWC] DocuSign instance created:', ds);

      this.instanceToken = ds.instanceToken;
      this.instanceId = ds.instanceId;
      this.currentFormId = formId;

      const sfRecordId = await createWebformInstanceRecord({
        instanceToken: this.instanceToken,
        instanceId: this.instanceId,
        formUrl: ds.formUrl,
        dbqWebformId
      });
      console.log('[LWC] Salesforce tracking record created:', sfRecordId);
      this.webformInstanceRecordId = sfRecordId;

      // 3) Defer mounting until renderedCallback
      // IMPORTANT: do NOT hand-build a URL with #instanceToken; let the SDK do it via options.instanceToken
      this.pendingFormUrl = ds.formUrl;
      this.pendingInstanceToken = ds.instanceToken;

      // 4) Flip to the embed view
      this.showSelector = false;
      this.isLoading = false;
      this.scheduleSelectorHeightUpdate();

      // Reset guards for a fresh session
      this._didEnd = false;
      this._didSubmit = false;
      this._didReady = false;
    } catch (error) {
      console.error('[LWC] Error creating instance or record:', error);
      this.errorMessage = error?.body?.message || error?.message || 'Unexpected error';
      this.isLoading = false;
    }
  }

  handleBackToSelector() {
    // Tear down listeners/iframe
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    if (this.webformsInstance && typeof this.webformsInstance.destroy === 'function') {
      try { this.webformsInstance.destroy(); } catch (e) { /* noop */ }
    }

    this.showSelector = true;
    this.instanceToken = null;
    this.instanceId = null;
    this.currentFormId = null;
    this.webformInstanceRecordId = null;
    this.webformsInstance = null;
    this.selectedCondition = null;
    this.selectedConditionId = null;
    this.pendingFormUrl = null;
    this.pendingInstanceToken = null;
    this.hasRendered = false;
    this._didEnd = false;
    this._didSubmit = false;
    this._didReady = false;

    this.scheduleSelectorHeightUpdate();
  }


  initializeWebform(container, formUrl, instanceToken) {
    try {
      console.log('[LWC] === Initializing webform ===');
      console.log('[LWC] Base URL:', formUrl);

      if (!this.docusignSDK || typeof this.docusignSDK.webforms !== 'function') {
        throw new Error('DocuSign SDK not properly initialized');
      }

      this.webformsInstance = this.docusignSDK.webforms({
        url: formUrl,
        options: {
          // CRUCIAL
          instanceToken: instanceToken,

          // UX flags
          showFinishLater: true,
          hideProgressBar: false,

          // iFrame behavior
          iframeHeightCalculationMethod: 'max',
          autoResizeHeight: true,

          // Keep iframe present after sessionEnd (optional, helps logging)
          dismissWidgetOnSessionEnd: false
        }
      });

      // Throttled update to avoid doubles if multiple paths fire
      const markInProgressOnce = () => {
        if (this._didEnd || this._didSubmit) return;
        this._didEnd = true;
        this.updateStatus('In Progress');
      };

      // Preferred path: SDK events (limit to interesting ones)
      const eventTypes = ['ready', 'submitted', 'sessionEnd'];
      eventTypes.forEach((eventType) => {
        this.webformsInstance.on(eventType, (event) => {
          console.log('[SDK]', eventType);

          switch (eventType) {
            case 'ready':
              if (!this._didReady) {
                this._didReady = true;
                this.updateStatus('Ready');
              }
              break;
            case 'submitted':
              if (this._didSubmit) return;
              this._didSubmit = true;
              this.updateStatus('Submitted');
              break;
            case 'sessionEnd':
              markInProgressOnce();
              break;
            default:
              // no-op
              break;
          }
        });
      });
      
      // Optional: keep a postMessage fallback; accept known senders and interesting events only
      this.messageHandler = (evt) => {
        const { data } = evt || {};
        if (!data) return;

        const allowedSenders = new Set(['WebFormsPlayer', '@embedded/signing-ui', '@embedded-js/core']);
        if (data.sender && !allowedSenders.has(data.sender)) return;

        const type = data.eventType || data.type;
        const interesting = new Set(['ready', 'submitted', 'sessionEnd']);
        if (!type || !interesting.has(type)) return;


        if (type === 'submitted') {
          if (!this._didSubmit) {
            this._didSubmit = true;
            this.updateStatus('Submitted');
          }
        } else if (type === 'sessionEnd') {
          const t = data?.content?.sessionEndType;
          if (t === 'finishLater' || t === 'finish_later') {
            markInProgressOnce();
          } else if (t === 'completed') {
            this.updateStatus('Submitted');
          } else {
            markInProgressOnce(); // unknown subtype — treat as in-progress
          }
        } else if (type === 'ready') {
          if (!this._didReady) {
            this._didReady = true;
            this.updateStatus('Ready');
          }
        }
      };
      window.addEventListener('message', this.messageHandler);
      

      // Finally mount the iframe
      this.webformsInstance.mount(container);
      
    } catch (error) {
      console.error('[LWC] Error in initializeWebform:', error);
      this.errorMessage = 'Failed to initialize webform: ' + (error?.message || error);
      this.showSelector = true;
    }
  }

  async updateStatus(status) {
    console.log('[Status]', status);

    if (!this.webformInstanceRecordId) {
      console.error('[Apex] Cannot update status - no record ID available');
      return;
    }

    try {
      const result = await updateWebformInstanceStatus({
        recordId: this.webformInstanceRecordId,
        status
      });
      
    } catch (error) {
      console.error('========================================');
      console.error('[Apex] ERROR UPDATING STATUS');
      console.error('Name:', error?.name);
      console.error('Message:', error?.message);
      console.error('Body:', error?.body);
      try {
        console.error('Full error object:', JSON.stringify(error, null, 2));
      } catch (e) { /* noop */ }
      console.error('========================================');
      this.errorMessage = error?.body?.message || error?.message || 'Failed to update status';
    }
  }

  scheduleSelectorHeightUpdate() {
    if (this._heightRaf) {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }
    this._heightRaf = window.requestAnimationFrame(() => {
      this._heightRaf = null;
      this.updateSelectorHeight();
    });
  }

  updateSelectorHeight() {
    if (!this.template) {
      return;
    }

    if (!this.showSelector) {
      this.template.host.style.removeProperty('--selector-height');
      this._lastSelectorHeight = null;
      return;
    }

    const hostRect = this.template.host.getBoundingClientRect();
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
    const available = viewportHeight - hostRect.top - 24;

    if (available <= 0) {
      return;
    }

    const rounded = Math.floor(available);
    if (this._lastSelectorHeight !== rounded) {
      this._lastSelectorHeight = rounded;
      this.template.host.style.setProperty('--selector-height', `${rounded}px`);
    }
  }
}
