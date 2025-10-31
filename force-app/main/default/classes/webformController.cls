public class webformController {
    
    private static final String TOKEN_ENDPOINT = 'https://account-d.docusign.com/oauth/token';
    private static final String WEBFORMS_BASE_URL = 'https://apps-d.docusign.com/api/webforms/v1.1';
    

    @AuraEnabled(cacheable=true)
    public static List<DBQ_Webform__c> getConditions() {
        return [
            SELECT Id, Condition__c, Category__c, Docusign_Webform_URL__c, Form_Id__c
            FROM DBQ_Webform__c 
            ORDER BY Category__c, Condition__c
        ];
    }

    @AuraEnabled
    public static Map<String, String> createWebformInstance(String formId) {
        try {
            // Get config
            Docusign_Webform_Private_Key__mdt config = getConfig();
            
            // Get access token
            String accessToken = getAccessToken(config);
            
            // Create instance
            HttpRequest createReq = new HttpRequest();
            String endpoint = WEBFORMS_BASE_URL + '/accounts/' + config.Account_ID__c + '/forms/' + formId + '/instances';
            createReq.setEndpoint(endpoint);
            createReq.setMethod('POST');
            createReq.setHeader('Authorization', 'Bearer ' + accessToken);
            createReq.setHeader('Content-Type', 'application/json');
            
            // Request body with Salesforce User ID as clientUserId
            Map<String, Object> requestBody = new Map<String, Object>{
                'clientUserId' => UserInfo.getUserId()
            };
            
            createReq.setBody(JSON.serialize(requestBody));
            
            Http http = new Http();
            HttpResponse createRes = http.send(createReq);
            
            if (createRes.getStatusCode() == 200 || createRes.getStatusCode() == 201) {
                Map<String, Object> instanceResponse = (Map<String, Object>) JSON.deserializeUntyped(createRes.getBody());
                
                return new Map<String, String>{
                    'instanceToken' => (String) instanceResponse.get('instanceToken'),
                    'formUrl' => (String) instanceResponse.get('formUrl'),
                    'instanceId' => (String) instanceResponse.get('id')
                };
            } else {
                throw new CalloutException('Failed to create instance: ' + createRes.getStatusCode() + ' - ' + createRes.getBody());
            }
            
        } catch (Exception e) {
            throw new AuraHandledException('Error creating webform instance: ' + e.getMessage());
        }
    }
    
    private static Docusign_Webform_Private_Key__mdt getConfig() {
        return [SELECT Private_Key__c, Integration_Key__c, User_ID__c, Account_ID__c 
                FROM Docusign_Webform_Private_Key__mdt 
                WHERE DeveloperName = 'Webform_API_Private_Key' 
                LIMIT 1];
    }
    
    private static String getAccessToken(Docusign_Webform_Private_Key__mdt config) {
        // Generate JWT
        String jwt = generateJWT(config);
        
        // Exchange JWT for access token
        HttpRequest req = new HttpRequest();
        req.setEndpoint(TOKEN_ENDPOINT);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
        req.setBody('grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt);
        
        Http http = new Http();
        HttpResponse res = http.send(req);
        
        if (res.getStatusCode() == 200) {
            Map<String, Object> tokenResponse = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            return (String) tokenResponse.get('access_token');
        }
        
        throw new CalloutException('Failed to get access token: ' + res.getStatusCode() + ' - ' + res.getBody());
    }
    
    private static String generateJWT(Docusign_Webform_Private_Key__mdt config) {
        // JWT Header
        String headerJson = '{"alg":"RS256","typ":"JWT"}';
        
        // JWT Payload with Web Forms API scopes
        Long now = System.currentTimeMillis() / 1000;
        Long exp = now + 3600;
        
        String payloadJson = '{' +
            '"iss":"' + config.Integration_Key__c + '",' +
            '"sub":"' + config.User_ID__c + '",' +
            '"aud":"account-d.docusign.com",' +
            '"iat":' + now + ',' +
            '"exp":' + exp + ',' +
            '"scope":"signature impersonation webforms_read webforms_instance_read webforms_instance_write"' +
            '}';
        
        // Base64URL encode
        Blob headerBlob = Blob.valueOf(headerJson);
        Blob payloadBlob = Blob.valueOf(payloadJson);
        
        String encodedHeader = EncodingUtil.base64Encode(headerBlob)
            .replace('+', '-').replace('/', '_').replace('=', '');
        String encodedPayload = EncodingUtil.base64Encode(payloadBlob)
            .replace('+', '-').replace('/', '_').replace('=', '');
        
        String signatureInput = encodedHeader + '.' + encodedPayload;
        
        // Sign with private key
        String privateKeyPEM = config.Private_Key__c
            .replace('-----BEGIN RSA PRIVATE KEY-----', '')
            .replace('-----END RSA PRIVATE KEY-----', '')
            .replaceAll('\\s', '');
        
        Blob privateKeyBlob = EncodingUtil.base64Decode(privateKeyPEM);
        Blob signatureBlob = Crypto.sign('RSA-SHA256', Blob.valueOf(signatureInput), privateKeyBlob);
        String encodedSignature = EncodingUtil.base64Encode(signatureBlob)
            .replace('+', '-').replace('/', '_').replace('=', '');
        
        return signatureInput + '.' + encodedSignature;
    }

    @AuraEnabled
    public static Id createWebformInstanceRecord(String instanceToken, String instanceId, String formUrl, Id dbqWebformId) {
        try {
            Webform_Instance__c instance = new Webform_Instance__c(
                Instance_Token__c = instanceToken,
                Instance_ID__c = instanceId,
                Form_URL__c = formUrl,
                Status__c = 'Created',
                DBQ_Webform__c = dbqWebformId
            );
            
            insert instance;
            
            return instance.Id;
            
        } catch (Exception e) {
            throw new AuraHandledException('Error creating Webform Instance record: ' + e.getMessage());
    }
}
}