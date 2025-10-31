import { LightningElement } from 'lwc';
import createWebformInstance from '@salesforce/apex/webformController.createWebformInstance';

export default class TestDocuSignWebform extends LightningElement {
    formId = '28086611-af1d-402c-8603-e284228af3e4'; // Default test form ID
    isLoading = false;
    errorMessage;
    instanceCreated = false;
    
    // Response data
    instanceToken;
    formUrl;
    instanceId;

    handleFormIdChange(event) {
        this.formId = event.target.value;
    }

    async handleCreateInstance() {
        if (!this.formId) {
            this.errorMessage = 'Please enter a Form ID';
            return;
        }

        this.isLoading = true;
        this.errorMessage = null;
        this.instanceCreated = false;

        try {
            console.log('Creating instance for form ID:', this.formId);
            
            const result = await createWebformInstance({ formId: this.formId });
            
            console.log('Result:', result);
            
            // Store results
            this.instanceToken = result.instanceToken;
            this.formUrl = result.formUrl;
            this.instanceId = result.instanceId;
            this.instanceCreated = true;
            
        } catch (error) {
            console.error('Error:', error);
            this.errorMessage = error.body ? error.body.message : error.message;
        } finally {
            this.isLoading = false;
        }
    }

    handleReset() {
        this.instanceCreated = false;
        this.instanceToken = null;
        this.formUrl = null;
        this.instanceId = null;
        this.errorMessage = null;
    }
}