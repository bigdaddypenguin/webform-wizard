import { LightningElement, wire } from 'lwc';
import getConditions from '@salesforce/apex/webformController.getConditions';
import createWebformInstance from '@salesforce/apex/webformController.createWebformInstance';
import createWebformInstanceRecord from '@salesforce/apex/webformController.createWebformInstanceRecord';

export default class docusignWebformIframe extends LightningElement {
    selectedUrl;
    showSelector = true;
    groupedConditions = [];
    isLoading = false;
    errorMessage;
    
    // Instance tracking
    instanceToken;
    instanceId;
    currentFormId;
    webformInstanceRecordId; // Salesforce record ID

    @wire(getConditions)
    wiredConditions({ data, error }) {
        if (data) {
            // Group by category
            const grouped = data.reduce((acc, condition) => {
                if (!acc[condition.Category__c]) {
                    acc[condition.Category__c] = [];
                }
                acc[condition.Category__c].push(condition);
                return acc;
            }, {});

            // Convert to array for iteration in template
            this.groupedConditions = Object.keys(grouped).map(category => ({
                category: category,
                conditions: grouped[category]
            }));
        }
        if (error) {
            console.error('Error loading conditions:', error);
            this.errorMessage = 'Failed to load conditions';
        }
    }

    async handleConditionClick(event) {
        this.isLoading = true;
        this.errorMessage = null;
        
        const formId = event.target.dataset.formid;
        const dbqWebformId = event.target.dataset.recordid;
        
        if (!formId) {
            this.errorMessage = 'Form ID not found for this condition';
            this.isLoading = false;
            return;
        }
        
        if (!dbqWebformId) {
            this.errorMessage = 'DBQ Webform record ID not found';
            this.isLoading = false;
            return;
        }
        
        console.log('Creating instance for form ID:', formId);
        console.log('DBQ Webform Record ID:', dbqWebformId);
        
        try {
            // Step 1: Create DocuSign instance
            const result = await createWebformInstance({ formId: formId });
            
            console.log('DocuSign instance created:', result);
            
            // Store instance data
            this.instanceToken = result.instanceToken;
            this.instanceId = result.instanceId;
            this.currentFormId = formId;
            this.selectedUrl = result.formUrl;
            
            // Step 2: Create Salesforce tracking record
            console.log('Creating Salesforce Webform_Instance__c record...');
            
            const sfRecordId = await createWebformInstanceRecord({
                instanceToken: this.instanceToken,
                instanceId: this.instanceId,
                formUrl: this.selectedUrl,
                dbqWebformId: dbqWebformId
            });
            
            console.log('Salesforce record created with ID:', sfRecordId);
            
            this.webformInstanceRecordId = sfRecordId;
            
            // Step 3: Show the iframe
            this.showSelector = false;
            
        } catch (error) {
            console.error('Error:', error);
            this.errorMessage = error.body ? error.body.message : error.message;
        } finally {
            this.isLoading = false;
        }
    }
    
    handleBackToSelector() {
        this.showSelector = true;
        this.selectedUrl = null;
        this.instanceToken = null;
        this.instanceId = null;
        this.currentFormId = null;
        this.webformInstanceRecordId = null;
    }
}