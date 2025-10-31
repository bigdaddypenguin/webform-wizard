public with sharing class dbqController {
    @AuraEnabled(cacheable=true)
    public static List<DBQ_Webform__c> getConditions() {
        return [
            SELECT Id, Condition__c, Category__c, Docusign_Webform_URL__c 
            FROM DBQ_Webform__c 
            ORDER BY Category__c, Condition__c
        ];
    }
}