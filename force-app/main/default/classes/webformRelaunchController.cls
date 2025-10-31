public with sharing class webformRelaunchController {

    // mirror your existing constants
    private static final String TOKEN_ENDPOINT     = 'https://account-d.docusign.com/oauth/token';
    private static final String WEBFORMS_BASE_URL  = 'https://apps-d.docusign.com/api/webforms/v1.1';

    // DTO returned to LWC
    public class InstanceInfo {
        @AuraEnabled public String instanceToken;
        @AuraEnabled public String instanceId;
        @AuraEnabled public String formUrl;
    }

    // ==== PUBLIC: refresh short-lived instanceToken for a Webform Instance record ====
    @AuraEnabled(cacheable=false)
    public static InstanceInfo refreshInstanceToken(Id recordId) {
        try {
            // Pull fields directly from the instance record (uses your API names)
            Webform_Instance__c rec = [
                SELECT Id,
                       Instance_ID__c,
                       Form_URL__c,
                       Form_ID__c,        // << the new formula field (GUID with dashes)
                       Instance_Token__c,
                       Status__c
                FROM Webform_Instance__c
                WHERE Id = :recordId
                LIMIT 1
            ];

            if (String.isBlank(rec.Instance_ID__c)) {
                throw new AuraHandledException('Instance_ID__c is missing on this Webform Instance record.');
            }
            if (String.isBlank(rec.Form_ID__c)) {
                throw new AuraHandledException('Form_ID__c is missing on this Webform Instance record.');
            }

            // Auth (same JWT flow as your existing controller)
            Docusign_Webform_Private_Key__mdt config = getConfig();
            String accessToken = getAccessToken(config);

            // Call the correct v1.1 refresh endpoint (with /forms/{formId}/.../refresh)
            String freshToken = refreshInstanceTokenFor(
                config.Account_ID__c,
                accessToken,
                rec.Form_ID__c,
                rec.Instance_ID__c
            );

            // Optional: persist for troubleshooting
            try {
                rec.Instance_Token__c = freshToken;
                update rec;
            } catch (DmlException ignore) {}

            InstanceInfo out = new InstanceInfo();
            out.instanceToken = freshToken;
            out.instanceId    = rec.Instance_ID__c;
            out.formUrl       = rec.Form_URL__c;
            return out;

        } catch (Exception e) {
            throw new AuraHandledException('Error refreshing instance token: ' + e.getMessage());
        }
    }

    // ==== LOW-LEVEL CALL ====
    private static String refreshInstanceTokenFor(String accountId, String accessToken, String formId, String instanceId) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(
            WEBFORMS_BASE_URL
            + '/accounts/'  + EncodingUtil.urlEncode(accountId, 'UTF-8')
            + '/forms/'     + EncodingUtil.urlEncode(formId, 'UTF-8')
            + '/instances/' + EncodingUtil.urlEncode(instanceId, 'UTF-8')
            + '/refresh'
        );
        req.setMethod('POST');
        req.setHeader('Authorization', 'Bearer ' + accessToken);
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000);
        req.setBody('{}'); // body not required, but OK to send '{}'

        Http http = new Http();
        HttpResponse res = http.send(req);

        if (res.getStatusCode() == 200 || res.getStatusCode() == 201) {
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            String token = (String) body.get('instanceToken');
            if (String.isBlank(token)) {
                throw new AuraHandledException('DocuSign did not return instanceToken.');
            }
            return token;
        }
        throw new CalloutException('Failed to refresh instance token: ' + res.getStatusCode() + ' - ' + res.getBody());
    }

    // ==== same config + JWT methods as your existing controller ====
    private static Docusign_Webform_Private_Key__mdt getConfig() {
        return [
            SELECT Private_Key__c, Integration_Key__c, User_ID__c, Account_ID__c
            FROM Docusign_Webform_Private_Key__mdt
            WHERE DeveloperName = 'Webform_API_Private_Key'
            LIMIT 1
        ];
    }

    private static String getAccessToken(Docusign_Webform_Private_Key__mdt config) {
        String jwt = generateJWT(config);

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
        String headerJson = '{"alg":"RS256","typ":"JWT"}';
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

        Blob headerBlob  = Blob.valueOf(headerJson);
        Blob payloadBlob = Blob.valueOf(payloadJson);

        String encodedHeader = EncodingUtil.base64Encode(headerBlob)
            .replace('+', '-').replace('/', '_').replace('=', '');
        String encodedPayload = EncodingUtil.base64Encode(payloadBlob)
            .replace('+', '-').replace('/', '_').replace('=', '');

        String signatureInput = encodedHeader + '.' + encodedPayload;

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
}
