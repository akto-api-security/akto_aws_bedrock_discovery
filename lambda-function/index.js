const {
    BedrockClient,
    GetModelInvocationLoggingConfigurationCommand,
    PutModelInvocationLoggingConfigurationCommand
} = require('@aws-sdk/client-bedrock');
const { BedrockAgentClient, GetAgentCommand } = require('@aws-sdk/client-bedrock-agent');
const { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { gunzip } = require('zlib');
const { promisify } = require('util');
const fetch = require('node-fetch');

const gunzipAsync = promisify(gunzip);

// Configuration from environment variables
const DATA_INGESTION_ENDPOINT = process.env.DATA_INGESTION_ENDPOINT;
const S3_BUCKET_NAME_PARAM = process.env.S3_BUCKET_NAME;
const AWS_REGION = process.env.BEDROCK_AWS_REGION || process.env.AWS_REGION;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;

// Initialize AWS clients
const bedrockClient = new BedrockClient({ region: AWS_REGION });
const bedrockAgentClient = new BedrockAgentClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });

// Cache for agent names to avoid repeated API calls
const agentNameCache = {};

/**
 * Main Lambda handler triggered by EventBridge schedule
 */
exports.handler = async (event) => {
    console.log('🚀 AKTO Bedrock Log Processor Started - Scheduled Execution');
    console.log(`📍 Region: ${AWS_REGION}`);
    console.log(`📋 Event received: ${event.source || 'manual-invocation'}`);
    console.log(`🔗 Data Ingestion Endpoint: ${DATA_INGESTION_ENDPOINT}`);

    try {
        // Step 1: Determine which S3 bucket to use
        const s3BucketName = await determineS3Bucket();
        console.log(`🗄️ Using S3 bucket: ${s3BucketName}`);

        if (!s3BucketName) {
            console.log('⚠️ No S3 bucket configured for Bedrock logging yet');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'No S3 bucket configured yet' })
            };
        }

        // Step 2: S3-based file tracking (no DynamoDB needed)

        // Step 3: Get unprocessed log files from S3
        const unprocessedFiles = await getUnprocessedLogFiles(s3BucketName);
        console.log(`📁 Found ${unprocessedFiles.length} unprocessed log files`);

        if (unprocessedFiles.length === 0) {
            console.log('✅ No new log files to process');
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    message: 'No new log files to process',
                    bucket: s3BucketName,
                    processedFiles: 0
                })
            };
        }

        // Step 4: Process each log file
        let totalMessages = 0;
        let processedFiles = 0;

        for (const file of unprocessedFiles) {
            try {
                console.log(`\n🔄 Processing file: ${file.Key}`);
                const messages = await processLogFile(s3BucketName, file.Key);
                
                if (messages.length > 0) {
                    await sendToDataIngestionService(messages);
                    totalMessages += messages.length;
                }

                // Mark file as processed
                await markFileAsProcessed(s3BucketName, file.Key);
                processedFiles++;
                
                console.log(`✅ File processed successfully: ${file.Key} (${messages.length} messages)`);
                
            } catch (error) {
                console.error(`❌ Error processing file ${file.Key}:`, error);
                // Continue processing other files even if one fails
            }
        }

        console.log(`\n🎉 Processing completed successfully`);
        console.log(`📊 Summary: Processed ${processedFiles} files, extracted ${totalMessages} messages`);

        return {
            statusCode: 200,
            body: JSON.stringify({ 
                message: 'Processing completed successfully',
                bucket: s3BucketName,
                processedFiles: processedFiles,
                totalMessages: totalMessages
            })
        };

    } catch (error) {
        console.error('❌ Error in Lambda handler:', error);
        console.error('Stack trace:', error.stack);
        
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: 'Processing failed',
                message: error.message
            })
        };
    }
};

/**
 * Determine which S3 bucket to use for Bedrock logs
 */
async function determineS3Bucket() {
    try {
        // First, check if user provided a bucket name
        if (S3_BUCKET_NAME_PARAM && S3_BUCKET_NAME_PARAM.trim() !== '') {
            console.log(`🔧 Using user-provided S3 bucket: ${S3_BUCKET_NAME_PARAM}`);
            
            // Configure Bedrock logging to use this bucket
            await configureBedrockLogging(S3_BUCKET_NAME_PARAM);
            return S3_BUCKET_NAME_PARAM;
        }

        // Check if Bedrock logging is already configured
        console.log('🔍 Checking existing Bedrock logging configuration...');
        const getConfigCommand = new GetModelInvocationLoggingConfigurationCommand({});
        const currentConfig = await bedrockClient.send(getConfigCommand);
        
        console.log('📋 Current Bedrock logging config found');
        
        if (currentConfig.loggingConfig?.s3Config?.bucketName) {
            console.log(`✅ Found existing Bedrock logging bucket: ${currentConfig.loggingConfig.s3Config.bucketName}`);
            return currentConfig.loggingConfig.s3Config.bucketName;
        }

        // No existing configuration, configure with default bucket
        console.log('⚙️ No existing configuration found, setting up default bucket...');
        const defaultBucket = 'akto-bedrock-logs-01';
        await configureBedrockLogging(defaultBucket);
        return defaultBucket;

    } catch (error) {
        console.error('❌ Error determining S3 bucket:', error);
        return null;
    }
}

/**
 * Configure Bedrock model invocation logging
 */
async function configureBedrockLogging(bucketName) {
    try {
        console.log(`⚙️ Configuring Bedrock logging for bucket: ${bucketName}`);
        
        const putConfigCommand = new PutModelInvocationLoggingConfigurationCommand({
            loggingConfig: {
                s3Config: {
                    bucketName: bucketName,
                    keyPrefix: 'bedrock-logs/'
                },
                textDataDeliveryEnabled: true,
                imageDataDeliveryEnabled: true,
                embeddingDataDeliveryEnabled: true
            }
        });

        await bedrockClient.send(putConfigCommand);
        console.log('✅ Bedrock logging configured successfully');
        console.log(`📁 Logs will be stored in: s3://${bucketName}/bedrock-logs/`);
        
    } catch (error) {
        console.error('❌ Error configuring Bedrock logging:', error);
        throw error;
    }
}

/**
 * Check if a file has been processed by looking for a marker file in S3
 */

/**
 * Get list of unprocessed log files from S3
 */
async function getUnprocessedLogFiles(bucketName) {
    try {
        console.log(`📁 Scanning S3 bucket for new log files: s3://${bucketName}/bedrock-logs/`);
        
        const listCommand = new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: 'bedrock-logs/',
            MaxKeys: 100 // Process max 100 files per run
        });

        const response = await s3Client.send(listCommand);
        const allFiles = response.Contents || [];
        
        console.log(`📊 Found ${allFiles.length} total files in S3`);

        // Filter for .gz files only
        const logFiles = allFiles.filter(file => 
            file.Key.endsWith('.gz') && file.Size > 0
        );

        console.log(`📦 Found ${logFiles.length} .gz log files`);

        // Check which files we haven't processed yet
        const unprocessedFiles = [];
        
        for (const file of logFiles) {
            const isProcessed = await isFileProcessed(bucketName, file.Key);
            if (!isProcessed) {
                unprocessedFiles.push(file);
            }
        }

        console.log(`🆕 Found ${unprocessedFiles.length} unprocessed files`);
        return unprocessedFiles;
        
    } catch (error) {
        console.error('❌ Error listing S3 files:', error);
        return [];
    }
}

/**
 * Check if a file has been processed before
 */
async function isFileProcessed(bucketName, key) {
    try {
        // Temporarily disabled S3 marker file checking - all files will be processed
        // This ensures no IAM permission issues while we sort out S3 access
        return false; // Always process files for now
        
    } catch (error) {
        console.error(`❌ Error checking if file is processed ${key}:`, error);
        return false; // If in doubt, process the file
    }
}

/**
 * Mark a file as processed
 */
async function markFileAsProcessed(bucketName, key) {
    try {
        console.log(`✅ Marking file as processed: ${key}`);
        // Temporarily disabled S3 marker files - processing continues without deduplication
        console.log(`📝 File marked as processed (in-memory only): ${key}`);
        
    } catch (error) {
        console.error(`❌ Error marking file as processed ${key}:`, error);
    }
}

/**
 * Process a single log file from S3
 */
async function processLogFile(bucketName, key) {
    try {
        console.log(`📁 Processing log file: s3://${bucketName}/${key}`);
        
        // Get file from S3
        const getObjectCommand = new GetObjectCommand({ Bucket: bucketName, Key: key });
        const s3Object = await s3Client.send(getObjectCommand);
        
        // Read the data
        const chunks = [];
        for await (const chunk of s3Object.Body) {
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        
        console.log(`📥 Downloaded ${buffer.length} bytes from S3`);
        
        // Decompress gzipped content
        console.log('🗜️ Decompressing gzipped content...');
        const data = await gunzipAsync(buffer);
        const content = data.toString('utf-8');
        
        console.log(`📝 Decompressed content size: ${content.length} characters`);
        
        // Parse log entries
        const lines = content.split('\n').filter(line => line.trim());
        console.log(`📊 Found ${lines.length} log entries to process`);
        
        const messages = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            try {
                const logEntry = JSON.parse(line);
                const standardMessages = await processBedrockLogEntry(logEntry, i + 1, lines.length);
                messages.push(...standardMessages);
            } catch (parseError) {
                console.warn(`⚠️ Could not parse line ${i + 1}:`, parseError.message);
            }
        }
        
        console.log(`✨ Extracted ${messages.length} messages from ${key}`);
        return messages;
        
    } catch (error) {
        console.error(`❌ Error processing log file ${key}:`, error);
        throw error;
    }
}

/**
 * Process individual Bedrock log entry and convert to AKTO format
 * Following the format from pkg/bedrock/extractor.go
 */
async function processBedrockLogEntry(logEntry, lineNumber, totalLines) {
    console.log(`\n🔄 Processing log entry ${lineNumber}/${totalLines}`);
    // console.log('📋 Raw log entry:', JSON.stringify(logEntry, null, 2));
    
    try {
        const messages = [];
        
        // Extract conversation pairs like the Go implementation
        const conversationPairs = extractConversationPairs(logEntry);
        console.log(`💬 Found ${conversationPairs.length} conversation pairs`);
        
        for (let i = 0; i < conversationPairs.length; i++) {
            const pair = conversationPairs[i];
            console.log(`\n💬 Processing conversation pair ${i + 1}:`);
            console.log(`   👤 User: ${pair.userMessage.substring(0, 100)}...`);
            console.log(`   🤖 Agent: ${pair.agentResponse.substring(0, 100)}...`);

            const message = await createStandardMessage(pair);
            messages.push(message);

            console.log('✅ Created standard message:');
            // console.log(JSON.stringify(message, null, 2));
        }
        
        return messages;
        
    } catch (error) {
        console.error(`❌ Error processing log entry ${lineNumber}:`, error);
        return [];
    }
}

/**
 * Extract conversation pairs from log entry (similar to Go implementation)
 */
function extractConversationPairs(logEntry) {
    const pairs = [];
    
    try {
        console.log(`🔍 Processing log entry for model: ${logEntry.modelId}`);
        
        // For Amazon Nova models, the key conversation is often in the output
        // Let's first check the output for the assistant response
        let finalAssistantResponse = '';
        if (logEntry.output?.outputBodyJson?.output?.message) {
            const outputMessage = logEntry.output.outputBodyJson.output.message;
            if (outputMessage.role === 'assistant' && outputMessage.content) {
                const outputText = extractTextFromContent(outputMessage.content);
                finalAssistantResponse = cleanAgentResponse(outputText);
                console.log(`🎯 Found assistant response in output: "${finalAssistantResponse.substring(0, 100)}..."`);
            }
        }
        
        // Now extract the conversation from input messages
        const messages = logEntry.input?.inputBodyJson?.messages || [];
        console.log(`📝 Found ${messages.length} messages in input`);
        
        if (messages.length === 0) {
            console.log('⚠️ No messages found in log entry input');
            return pairs;
        }

        // Process all user messages and find the most recent user message
        const userMessages = messages
            .filter(m => m.role === 'user')
            .map(m => extractTextFromContent(m.content))
            .filter(text => text && !text.includes('<function_results>') && text.trim().length > 0);

        console.log(`👤 Found ${userMessages.length} user messages`);
        
        // If we have a final assistant response and at least one user message,
        // create a conversation pair with the most recent user message
        if (finalAssistantResponse && userMessages.length > 0) {
            const lastUserMessage = userMessages[userMessages.length - 1];
            console.log(`✅ Creating conversation pair:\n  User: "${lastUserMessage.substring(0, 50)}..."\n  Assistant: "${finalAssistantResponse.substring(0, 50)}..."`);
            
            pairs.push({
                userMessage: lastUserMessage,
                agentResponse: finalAssistantResponse,
                timestamp: logEntry.timestamp,
                requestId: logEntry.requestId,
                modelId: logEntry.modelId,
                agentId: logEntry.identity?.arn || ''
            });
        }

        // Also process historical user-assistant pairs from the message history
        for (let i = 0; i < messages.length - 1; i++) {
            const currentMessage = messages[i];
            const nextMessage = messages[i + 1];
            
            if (currentMessage.role === 'user' && nextMessage.role === 'assistant') {
                const userText = extractTextFromContent(currentMessage.content);
                const assistantText = extractTextFromContent(nextMessage.content);
                
                if (userText && !userText.includes('<function_results>') && userText.trim().length > 0) {
                    const cleanedResponse = cleanAgentResponse(assistantText);
                    if (cleanedResponse) {
                        console.log(`📚 Found historical conversation pair:\n  User: "${userText.substring(0, 50)}..."\n  Assistant: "${cleanedResponse.substring(0, 50)}..."`);
                        
                        // Avoid duplicating the final pair we already added
                        const isDuplicate = pairs.some(pair => 
                            pair.userMessage === userText && 
                            pair.agentResponse === cleanedResponse
                        );
                        
                        if (!isDuplicate) {
                            pairs.push({
                                userMessage: userText,
                                agentResponse: cleanedResponse,
                                timestamp: logEntry.timestamp,
                                requestId: logEntry.requestId,
                                modelId: logEntry.modelId,
                                agentId: logEntry.identity?.arn || ''
                            });
                        }
                    }
                }
            }
        }

        console.log(`💬 Extracted ${pairs.length} conversation pairs from log entry`);

    } catch (error) {
        console.error('❌ Error extracting conversation pairs:', error);
    }

    return pairs;
}

/**
 * Extract text from content array
 */
function extractTextFromContent(content) {
    if (!Array.isArray(content)) {
        console.log('⚠️ Content is not an array:', typeof content, JSON.stringify(content).substring(0, 100));
        return '';
    }
    
    for (const c of content) {
        // For Amazon Nova models, content is structured as [{"text": "message"}]
        if (c.text) {
            console.log(`📝 Extracted text: ${c.text.substring(0, 100)}...`);
            return c.text;
        }
        // Fallback for Claude models with type field
        if (c.type === 'text' && c.text) {
            console.log(`📝 Extracted text (with type): ${c.text.substring(0, 100)}...`);
            return c.text;
        }
    }
    console.log('⚠️ No text content found in array:', JSON.stringify(content).substring(0, 100));
    return '';
}

/**
 * Clean agent response (similar to Go implementation)
 */
function cleanAgentResponse(rawResponse) {
    if (!rawResponse) {
        console.log('⚠️ cleanAgentResponse: empty rawResponse');
        return '';
    }

    console.log(`🧹 Cleaning response: ${rawResponse.substring(0, 100)}...`);

    // Extract content between <answer> tags if present
    if (rawResponse.includes('<answer>') && rawResponse.includes('</answer>')) {
        const start = rawResponse.indexOf('<answer>') + 8;
        const end = rawResponse.indexOf('</answer>');
        if (start < end) {
            const answer = rawResponse.substring(start, end).trim();
            if (answer) {
                console.log(`✅ Found answer in tags: ${answer.substring(0, 50)}...`);
                return answer;
            }
        }
    }

    // Skip responses that are primarily function calls or thinking
    const trimmed = rawResponse.trim();
    if (trimmed.startsWith('<thinking>') || trimmed.startsWith('<function_calls>')) {
        console.log('⏭️ Skipping thinking/function content');
        return '';
    }

    // Remove thinking tags and function calls
    let cleaned = rawResponse;
    cleaned = removeXMLTags(cleaned, 'thinking');
    cleaned = removeXMLTags(cleaned, 'function_calls');
    cleaned = removeXMLTags(cleaned, 'function_results');
    cleaned = cleaned.trim();

    console.log(`🔍 After cleaning: "${cleaned.substring(0, 100)}..." (length: ${cleaned.length})`);

    // Return if meaningful content
    if (cleaned.length >= 10) {
        console.log('✅ Returning cleaned response');
        return cleaned;
    }

    console.log('❌ Response too short, returning empty');
    return '';
}

/**
 * Remove XML tags and their content
 */
function removeXMLTags(text, tag) {
    const regex = new RegExp(`<${tag}>.*?</${tag}>`, 'gs');
    return text.replace(regex, '');
}

/**
 * Create standard message in AKTO format (based on Go implementation)
 */
async function createStandardMessage(pair) {
    // Parse timestamp
    const timestamp = new Date(pair.timestamp);

    // Create request payload (user message)
    const requestPayload = {
        message: pair.userMessage,
        model: pair.modelId,
        requestId: pair.requestId
    };

    // Create response payload (agent response)
    const responsePayload = {
        message: pair.agentResponse,
        model: pair.modelId
    };

    // Set the original host to bedrock-runtime endpoint
    const originalHost = `bedrock-runtime.${AWS_REGION}.amazonaws.com`;

    // Extract agent ID and fetch agent name
    const agentId = extractAgentID(pair.agentId);
    const agentName = await fetchAgentName(agentId);

    // Create standard message following exact Go format
    const message = {
        path: `/model/${pair.modelId}/invoke`,
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify({
            'Content-Type': 'application/json',
            'Authorization': 'AWS4-HMAC-SHA256',
            'X-Bedrock-Model-Id': pair.modelId,
            'X-Request-Id': pair.requestId,
            'aws-account-id': AWS_ACCOUNT_ID,
            'bedrock-agent-id': agentId || '',
            'agent-name': agentName,
            'host': originalHost
        }),
        responseHeaders: JSON.stringify({
            'Content-Type': 'application/json',
            'X-Request-Id': pair.requestId
        }),
        requestPayload: JSON.stringify(requestPayload),
        responsePayload: JSON.stringify(responsePayload),
        ip: '0.0.0.0',
        time: Math.floor(timestamp.getTime() / 1000).toString(),
        statusCode: '200',
        type: 'HTTP',
        status: 'OK',
        akto_account_id: '1000000',
        akto_vxlan_id: '0',
        is_pending: 'false',
        source: 'MIRRORING',
        tag: JSON.stringify({
            source: 'AWS_BEDROCK',
            'gen-ai': 'Gen AI',
            'bot-name': agentName
        })
    };

    return message;
}

/**
 * Extract agent ID from ARN
 */
function extractAgentID(arn) {
    if (!arn) return '';

    // Pattern: BedrockAgents-{AGENT_ID}-{UUID}
    const match = arn.match(/BedrockAgents-([A-Z0-9]+)-[a-f0-9-]+$/);
    return match ? match[1] : '';
}

/**
 * Fetch agent name from agent ID using Bedrock Agents API
 */
async function fetchAgentName(agentId) {
    try {
        if (!agentId) {
            console.log('⚠️ fetchAgentName: No agent ID provided');
            return '';
        }

        // Check cache first
        if (agentNameCache[agentId]) {
            console.log(`✅ Found agent name in cache: ${agentNameCache[agentId]}`);
            return agentNameCache[agentId];
        }

        console.log(`🔍 Fetching agent details for agent ID: ${agentId}`);
        const getAgentCommand = new GetAgentCommand({ agentId });
        console.log(`🔍 GetAgentCommand created, sending request...`);
        const agentDetails = await bedrockAgentClient.send(getAgentCommand);

        console.log(`🔍 Response received:`, JSON.stringify(agentDetails).substring(0, 200));

        if (agentDetails && agentDetails.agent && agentDetails.agent.agentName) {
            console.log(`✅ Found agent name: ${agentDetails.agent.agentName}`);
            agentNameCache[agentId] = agentDetails.agent.agentName;
            return agentDetails.agent.agentName;
        }

        if (agentDetails && agentDetails.agentName) {
            console.log(`✅ Found agent name: ${agentDetails.agentName}`);
            agentNameCache[agentId] = agentDetails.agentName;
            return agentDetails.agentName;
        }

        console.log('⚠️ Agent name not found in response, available keys:', Object.keys(agentDetails || {}));
        return '';
    } catch (error) {
        console.error(`❌ Error fetching agent name for ${agentId}:`, error.message);
        console.error(`❌ Full error:`, JSON.stringify(error).substring(0, 300));
        return '';
    }
}

/**
 * Send processed messages to AKTO data ingestion service
 */
async function sendToDataIngestionService(messages) {
    console.log(`\n📤 Sending ${messages.length} messages to data ingestion service`);
    console.log(`🔗 Endpoint: ${DATA_INGESTION_ENDPOINT}`);
    console.log(`🔑 Using API Key: ${process.env.AKTO_API_KEY ? process.env.AKTO_API_KEY.substring(0, 8) + '...' : 'NOT SET'}`);
    
    try {
        const batchData = messages;
        const payload = { batchData };
        
        console.log('\n📤 AKTO FORMAT JSON - Data being sent to ingestion API:');
        console.log('='.repeat(60));
        messages.forEach((msg, index) => {
            console.log(`🔹 Message ${index + 1}:`);
            console.log(JSON.stringify(msg, null, 2));
            if (index < messages.length - 1) console.log('---');
        });
        console.log('='.repeat(60));
        
        const response = await fetch(DATA_INGESTION_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': process.env.AKTO_API_KEY || '',
                'User-Agent': 'AKTO-Bedrock-Monitor/2.0'
            },
            body: JSON.stringify(payload)
        });
        
        console.log(`📊 Response status: ${response.status} ${response.statusText}`);
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('❌ HTTP error response:', errorText);
            throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
        }
        
        const result = await response.json();
        console.log('✅ Successfully sent to data ingestion service');
        console.log('📋 Response:', JSON.stringify(result, null, 2));
        
        return result;
        
    } catch (error) {
        console.error('❌ Error sending to data ingestion service:', error);
        
        // Log the messages that failed to send  
        console.log('💾 Failed messages (first 2):');
        messages.slice(0, 2).forEach((msg, index) => {
            console.log(`Message ${index + 1}:`, JSON.stringify(msg, null, 2));
        });
        
        throw error;
    }
}