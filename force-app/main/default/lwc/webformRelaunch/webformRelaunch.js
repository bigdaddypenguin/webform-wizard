import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import { loadScript } from 'lightning/platformResourceLoader';

import STATUS_FIELD from '@salesforce/schema/Webform_Instance__c.Status__c';
import FORM_URL_FIELD from '@salesforce/schema/Webform_Instance__c.Form_URL__c';
import INSTANCE_ID_FIELD from '@salesforce/schema/Webform_Instance__c.Instance_ID__c';

import refreshInstanceToken from '@salesforce/apex/webformRelaunchController.refreshInstanceToken';
import updateWebformInstanceStatus from '@salesforce/apex/betterWebformController.updateWebformInstanceStatus';

import docusignBundle from '@salesforce/resourceUrl/docusign_js';

const FIELDS = [STATUS_FIELD, FORM_URL_FIELD, INSTANCE_ID_FIELD];

export default class WebformRelaunch extends LightningElement {
  @api recordId;

  // UI
  isLoading = true;
  errorMessage;

  // record
  status;
  formUrl;
  instanceId;

  // DocuSign
  ds;
  sdkLoaded = false;
  webformsInstance;

  instanceToken;

  // guards
  _didEnd = false;
  _didSubmit = false;

  // flow control
  pendingResume = false;
  sdkLoadTimeoutId;

get canRender() {
  // Render the container whenever the record is In Progress,
  // even while loading (spinner can sit on top)
  return !this.errorMessage && this.status === 'In Progress';
}

  get showNotInProgress() {
    return !this.isLoading && !this.errorMessage && this.status !== 'In Progress';
  }

  /* Load SDK once */
  async connectedCallback() {
    try {
      // Start a safety timeout so we never spin forever
      this.sdkLoadTimeoutId = window.setTimeout(() => {
        if (!this.sdkLoaded) {
          this.errorMessage = 'DocuSign SDK took too long to load.';
          this.isLoading = false;
        }
      }, 15000);

      await loadScript(this, docusignBundle);
      this.ds = await window.DocuSign.loadDocuSign('WEBFORMS_PUBLIC');
      this.sdkLoaded = true;

      // If the record said “In Progress” before SDK loaded, resume now
      if (this.pendingResume) {
        this.pendingResume = false;
        await this.resume();
      }
    } catch (e) {
      this.errorMessage = 'Failed to load DocuSign SDK: ' + (e?.message || e);
      this.isLoading = false;
    } finally {
      if (this.sdkLoadTimeoutId) {
        window.clearTimeout(this.sdkLoadTimeoutId);
        this.sdkLoadTimeoutId = null;
      }
    }
  }

  /* Load the record */
  @wire(getRecord, { recordId: '$recordId', fields: FIELDS })
  wiredRecord({ data, error }) {
    if (error) {
      this.errorMessage = 'Failed to load Webform Instance record';
      this.isLoading = false;
      return;
    }
    if (!data) return;

    this.status = getFieldValue(data, STATUS_FIELD);
    this.formUrl = getFieldValue(data, FORM_URL_FIELD);
    this.instanceId = getFieldValue(data, INSTANCE_ID_FIELD);

    if (this.status === 'In Progress') {
      // If SDK is ready, resume immediately; else mark for later
      if (this.sdkLoaded) {
        this.resume();
      } else {
        this.pendingResume = true;
        // keep spinner on while we wait for SDK
      }
    } else {
      this.isLoading = false;
    }
  }

  /* Manual retry */
  async reload() {
    await this.resume();
  }

  /* Refresh token, mount */
  async resume() {
    try {
      this.isLoading = true;
      this.errorMessage = null;

      if (!this.sdkLoaded) {
        // Instead of erroring, just defer until loaded
        this.pendingResume = true;
        return;
      }
      if (!this.formUrl || !this.instanceId) {
        throw new Error('Missing form URL or Instance ID on the record');
      }

      const refreshed = await refreshInstanceToken({ recordId: this.recordId });
      this.instanceToken = refreshed.instanceToken;
      this.formUrl = refreshed.formUrl || this.formUrl;
      this.instanceId = refreshed.instanceId || this.instanceId;

      if (!this.instanceToken) {
        throw new Error('Failed to obtain a fresh instance token');
      }

      const container = this.template.querySelector('[data-id="webform-container"]');
      if (!container) throw new Error('Container not found');

      if (this.webformsInstance?.destroy) {
        try { this.webformsInstance.destroy(); } catch (_) {}
        this.webformsInstance = null;
      }

      this.mount(container, this.formUrl, this.instanceToken);
      this.isLoading = false;
    } catch (e) {
      this.errorMessage = e?.body?.message || e?.message || 'Unexpected error resuming webform';
      this.isLoading = false;
    }
  }

  /* Embed */
  mount(container, formUrl, instanceToken) {
    this._didEnd = false;
    this._didSubmit = false;

    this.webformsInstance = this.ds.webforms({
      url: formUrl,
      options: {
        instanceToken,
        showFinishLater: true,
        hideProgressBar: false,
        iframeHeightCalculationMethod: 'max',
        autoResizeHeight: true,
        dismissWidgetOnSessionEnd: false
      }
    });

    const markInProgressOnce = () => {
      if (this._didEnd || this._didSubmit) return;
      this._didEnd = true;
      this.updateStatus('In Progress');
    };

    ['ready', 'submitted', 'sessionEnd'].forEach(evt => {
      this.webformsInstance.on(evt, (payload) => {
        // eslint-disable-next-line no-console
        console.log('[relaunch SDK]', evt, payload);
        if (evt === 'submitted') {
          if (!this._didSubmit) {
            this._didSubmit = true;
            this.updateStatus('Submitted');
          }
        } else if (evt === 'sessionEnd') {
          markInProgressOnce();
        }
      });
    });

    this.webformsInstance.mount(container);
  }

  /* Apex status update */
  async updateStatus(status) {
    try {
      await updateWebformInstanceStatus({ recordId: this.recordId, status });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to update status', e);
      this.errorMessage = e?.body?.message || e?.message || 'Failed to update status';
    }
  }
}
