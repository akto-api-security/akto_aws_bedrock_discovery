const {
    BedrockClient,
    GetModelInvocationLoggingConfigurationCommand,
    PutModelInvocationLoggingConfigurationCommand
} = require('@aws-sdk/client-bedrock');
const { BedrockAgentClient, GetAgentCommand, ListTagsForResourceCommand: BedrockAgentListTagsCommand } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentCoreControlClient, ListHarnessesCommand, GetHarnessCommand, ListTagsForResourceCommand: BedrockCoreListTagsCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
const { LambdaClient, ListTagsCommand, GetFunctionCommand } = require('@aws-sdk/client-lambda');
const { IAMClient, ListRolePoliciesCommand, ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
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
const bedrockAgentCoreControlClient = new BedrockAgentCoreControlClient({ region: AWS_REGION });
const s3Client = new S3Client({ region: AWS_REGION });
const lambdaClient = new LambdaClient({ region: AWS_REGION });
const iamClient = new IAMClient({ region: AWS_REGION });

// Cache for agent names and harness details to avoid repeated API calls
const agentNameCache = {};
const harnessNameCache = {}; // Maps role-suffix (fr53w, dv8m2) to harness name
const harnessIdCache = {}; // Maps role-suffix (fr53w, dv8m2) to harness ID
const harnessExecutionRoleCache = {}; // Maps role-suffix (fr53w, dv8m2) to execution role ARN

// Cache for resource tags
const resourceTagsCache = {};
let harnessInitialized = false;

/**
 * Main Lambda handler triggered by EventBridge schedule
 */
exports.handler = async (event) => {
    console.log('🚀 AKTO Bedrock Log Processor Started - Scheduled Execution');
    console.log(`📍 Region: ${AWS_REGION}`);
    console.log(`📋 Event received: ${event.source || 'manual-invocation'}`);
    console.log(`🔗 Data Ingestion Endpoint: ${DATA_INGESTION_ENDPOINT}`);

    try {
        // Initialize harness cache once at startup
        if (!harnessInitialized) {
            await initializeHarnessCache();
            harnessInitialized = true;
        }
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
        const markerKey = `${key}.processed`;

        try {
            // Try to head the marker file
            const headCommand = new HeadObjectCommand({
                Bucket: bucketName,
                Key: markerKey
            });
            await s3Client.send(headCommand);
            console.log(`✅ Marker file exists for ${key} - File already processed`);
            return true;
        } catch (error) {
            // Marker file doesn't exist - file not processed yet
            if (error.name === 'NotFound') {
                console.log(`🆕 No marker file for ${key} - File not processed yet`);
                return false;
            }
            // Some other error occurred
            throw error;
        }

    } catch (error) {
        console.error(`❌ Error checking if file is processed ${key}:`, error);
        return false; // If in doubt, process the file
    }
}

/**
 * Mark a file as processed by creating a marker file in S3
 */
async function markFileAsProcessed(bucketName, key) {
    try {
        const markerKey = `${key}.processed`;
        const timestamp = new Date().toISOString();
        const markerContent = JSON.stringify({
            processedAt: timestamp,
            originalFile: key,
            version: '1.0'
        });

        const putCommand = new PutObjectCommand({
            Bucket: bucketName,
            Key: markerKey,
            Body: markerContent,
            ContentType: 'application/json'
        });

        await s3Client.send(putCommand);
        console.log(`✅ Marker file created: ${markerKey}`);
        console.log(`📝 File marked as processed at: ${timestamp}`);

    } catch (error) {
        console.error(`❌ Error marking file as processed ${key}:`, error);
        throw error; // Don't silently fail - we want to know if marking fails
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

            // Determine botName for this pair
            let botName = '';
            if (pair.logType === 'AGENT') {
                botName = await fetchAgentName(pair.agentId);
            } else if (pair.logType === 'HARNESS') {
                botName = getHarnessName(pair.harnessRoleSuffix);
            }
            console.log(`🤖 Bot Name: ${botName}`);

            // Extract trace data from log entry with botName
            const traceDataInfo = extractTraceData(logEntry, botName);
            console.log(`🔗 Extracted trace data with ${traceDataInfo.executionFlow.length} steps`);

            // Add trace data to pair
            pair.traceData = traceDataInfo;

            console.log(`\n💬 Processing conversation pair ${i + 1}:`);
            console.log(`   👤 User: ${pair.userMessage.substring(0, 100)}...`);
            console.log(`   🤖 Agent: ${pair.agentResponse.substring(0, 100)}...`);
            console.log(`   📊 Trace: ${traceDataInfo.executionFlow.length} execution steps`);

            const message = await createStandardMessage(pair);
            messages.push(message);

            console.log('✅ Created standard message');
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
            const arn = logEntry.identity?.arn || '';
            const logType = detectLogType(arn);
            console.log(`✅ Creating conversation pair (Type: ${logType}):\n  User: "${lastUserMessage.substring(0, 50)}..."\n  Assistant: "${finalAssistantResponse.substring(0, 50)}..."`);

            const harnessRoleSuffix = extractHarnessRoleSuffix(arn);
            const harnessName = logType === 'HARNESS' ? getHarnessName(harnessRoleSuffix) : '';
            const harnessId = logType === 'HARNESS' ? getHarnessId(harnessRoleSuffix) : '';

            pairs.push({
                userMessage: lastUserMessage,
                agentResponse: finalAssistantResponse,
                timestamp: logEntry.timestamp,
                requestId: logEntry.requestId,
                modelId: logEntry.modelId,
                agentId: extractAgentID(arn),
                harnessRoleSuffix: harnessRoleSuffix,
                harnessName: harnessName,
                harnessId: harnessId,
                arn: arn,
                logType: logType,
                operation: logEntry.operation || 'Unknown',
                accountId: logEntry.accountId || AWS_ACCOUNT_ID,
                region: logEntry.region || AWS_REGION,
                inputTokenCount: logEntry.input?.inputTokenCount || 0,
                outputTokenCount: logEntry.output?.outputTokenCount || 0
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
                        const arn = logEntry.identity?.arn || '';
                        const logType = detectLogType(arn);
                        console.log(`📚 Found historical conversation pair (Type: ${logType}):\n  User: "${userText.substring(0, 50)}..."\n  Assistant: "${cleanedResponse.substring(0, 50)}..."`);

                        // Avoid duplicating the final pair we already added
                        const isDuplicate = pairs.some(pair =>
                            pair.userMessage === userText &&
                            pair.agentResponse === cleanedResponse
                        );

                        if (!isDuplicate) {
                            const harnessRoleSuffix = extractHarnessRoleSuffix(arn);
                            const harnessName = logType === 'HARNESS' ? getHarnessName(harnessRoleSuffix) : '';
                            const harnessId = logType === 'HARNESS' ? getHarnessId(harnessRoleSuffix) : '';

                            pairs.push({
                                userMessage: userText,
                                agentResponse: cleanedResponse,
                                timestamp: logEntry.timestamp,
                                requestId: logEntry.requestId,
                                modelId: logEntry.modelId,
                                agentId: extractAgentID(arn),
                                harnessRoleSuffix: harnessRoleSuffix,
                                harnessName: harnessName,
                                harnessId: harnessId,
                                arn: arn,
                                logType: logType,
                                operation: logEntry.operation || 'Unknown',
                                accountId: logEntry.accountId || AWS_ACCOUNT_ID,
                                region: logEntry.region || AWS_REGION,
                                inputTokenCount: logEntry.input?.inputTokenCount || 0,
                                outputTokenCount: logEntry.output?.outputTokenCount || 0
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
 * Extract trace data from log entry (tool calls in assistant response or message history)
 */
function extractTraceData(logEntry, botName) {
    try {
        const messages = logEntry.input?.inputBodyJson?.messages || [];
        const stopReason = logEntry.output?.outputBodyJson?.stopReason;

        console.log(`🔍 Extracting trace data - Messages: ${messages.length}, StopReason: ${stopReason}`);

        // Look for assistant messages in input messages (conversation history)
        let toolCallsFound = [];

        for (let i = 0; i < messages.length; i++) {
            if (messages[i].role === 'assistant') {
                const content = messages[i].content || [];
                const toolUses = content.filter(item => item.toolUse);
                if (toolUses.length > 0) {
                    console.log(`✅ Found ${toolUses.length} tool calls in message ${i}`);
                    toolCallsFound = toolCallsFound.concat(toolUses);
                }
            }
        }

        // If no tools found in history, check output message for tool calls
        if (toolCallsFound.length === 0 && stopReason === 'tool_use') {
            const outputMessage = logEntry.output?.outputBodyJson?.output?.message;
            if (outputMessage && outputMessage.content) {
                const toolUses = outputMessage.content.filter(item => item.toolUse);
                if (toolUses.length > 0) {
                    console.log(`✅ Found ${toolUses.length} tool calls in output message`);
                    toolCallsFound = toolUses;
                }
            }
        }

        if (toolCallsFound.length === 0) {
            console.log(`⚠️ No tool calls found (this may be a thinking-only response)`);
            return { executionFlow: [], toolsSummary: {} };
        }

        const traceData = [
            {
                step: 0,
                type: "agent",
                name: botName,
                action: "orchestrate",
                description: "Agent orchestrating tool calls"
            }
        ];

        let stepCounter = 1;
        const toolsSet = new Set();
        const actionsSet = new Set();

        for (const toolUseItem of toolCallsFound) {
            const toolName = toolUseItem.toolUse?.name || 'unknown';
            const actionType = toolUseItem.toolUse?.input?.action?.type || 'unknown';

            traceData.push({
                step: stepCounter++,
                type: "tool-call",
                tool: toolName,
                action: actionType,
                toolUseId: toolUseItem.toolUse?.toolUseId || ''
            });

            toolsSet.add(toolName);
            actionsSet.add(actionType);
        }

        const executionPattern = botName + "→" + Array.from(toolsSet).join("→");

        console.log(`📊 Trace summary: ${toolsSet.size} tools, ${toolCallsFound.length} tool calls`);

        return {
            executionFlow: traceData,
            toolsSummary: {
                agentOrchestrator: botName,
                tools: Array.from(toolsSet),
                actions: Array.from(actionsSet),
                totalToolCalls: stepCounter - 1,
                executionPattern: executionPattern
            }
        };
    } catch (error) {
        console.log(`⚠️ Could not extract trace data: ${error.message}`);
        return { executionFlow: [], toolsSummary: {} };
    }
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

    // Remove function calls and results, but KEEP thinking tags
    let cleaned = rawResponse;
    // Keep thinking tags - they contain valuable agent reasoning
    // cleaned = removeXMLTags(cleaned, 'thinking'); // REMOVED - keep thinking tags
    cleaned = removeXMLTags(cleaned, 'function_calls');
    cleaned = removeXMLTags(cleaned, 'function_results');
    cleaned = cleaned.trim();

    console.log(`🔍 After cleaning: "${cleaned.substring(0, 100)}..." (length: ${cleaned.length})`);

    // Return if meaningful content exists (at least 10 characters)
    if (cleaned.length >= 10) {
        console.log('✅ Returning cleaned response');
        return cleaned;
    }

    console.log('❌ Response too short or empty, returning empty');
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

    // Fetch name based on log type
    let botName = '';
    if (pair.logType === 'AGENT') {
        botName = await fetchAgentName(pair.agentId);
    } else if (pair.logType === 'HARNESS') {
        botName = getHarnessName(pair.harnessRoleSuffix);
    }

    // Fetch resource tags (only agent and harness)
    let agentTags = {};
    let harnessTags = {};
    let awsMetadata = {};

    if (pair.logType === 'AGENT' && pair.agentId) {
        agentTags = await getBedrockAgentTags(pair.agentId);
        // Add agent execution role and its policies to tags
        agentTags = await addAgentRoleAndPermissions(agentTags, pair.agentId);
    } else if (pair.logType === 'HARNESS' && pair.harnessId) {
        harnessTags = await getHarnessTags(pair.harnessId);
        // Add harness execution role and its policies to tags
        const harnessExecutionRoleArn = getHarnessExecutionRoleArn(pair.harnessRoleSuffix);
        harnessTags = await addHarnessRoleAndPermissions(harnessTags, harnessExecutionRoleArn);
        // Add harness configured tools and skills to tags
        const toolsAndSkills = await getHarnessToolsAndSkills(pair.harnessId);
        harnessTags = { ...harnessTags, ...toolsAndSkills };

        // Build awsMetadata for harness with key fields
        awsMetadata = {
            'harness-configured-tools': toolsAndSkills['harness-configured-tools'] || '',
            'harness-configured-skills': toolsAndSkills['harness-configured-skills'] || '',
            'model': pair.modelId,
            'harness-execution-role': harnessTags['harness-execution-role'] || '',
            'bedrock-execution-role': harnessTags['bedrock-execution-role'] || '',
            'traceData': pair.traceData || {}
        };
    }

    // Set the original host to bedrock-runtime endpoint
    const originalHost = `bedrock-runtime.${AWS_REGION}.amazonaws.com`;

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

    // Build request headers with enriched metadata
    const requestHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'AWS4-HMAC-SHA256',
        'X-Bedrock-Model-Id': pair.modelId,
        'X-Request-Id': pair.requestId,
        'aws-account-id': pair.accountId || AWS_ACCOUNT_ID,
        'bedrock-agent-id': pair.agentId || '',
        'bedrock-harness-id': pair.harnessId || '',
        'agent-name': botName,
        'host': originalHost,
        'bedrock-operation': pair.operation || 'Unknown',
        'bedrock-identity-arn': pair.arn || '',
        'bedrock-region': pair.region || AWS_REGION,
        'bedrock-input-tokens': (pair.inputTokenCount || 0).toString(),
        'bedrock-output-tokens': (pair.outputTokenCount || 0).toString()
    };

    // Create standard message following exact Go format
    const message = {
        path: `/model/${pair.modelId}/invoke`,
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify(requestHeaders),
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
            'agentType': pair.logType === 'AGENT' ? 'BEDROCK_AGENT' : (pair.logType === 'HARNESS' ? 'AGENTCORE_AGENT' : 'UNKNOWN'),
            'bot-name': botName,
            'operation': pair.operation || 'Unknown',
            'agent-id': pair.logType === 'AGENT' ? (pair.agentId || '') : '',
            'harness-id': pair.logType === 'HARNESS' ? (pair.harnessId || '') : '',
            'account-id': pair.accountId || AWS_ACCOUNT_ID,
            'region': pair.region || AWS_REGION,
            'model': pair.modelId,
            'input-tokens': (pair.inputTokenCount || 0).toString(),
            'output-tokens': (pair.outputTokenCount || 0).toString(),
            'bedrock-identity-arn': pair.arn || '',
            ...(pair.logType === 'AGENT' ? agentTags : harnessTags)
        }),
        awsMetadata: JSON.stringify(awsMetadata)
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
 * Initialize harness cache by fetching all harnesses and mapping role suffix to harness name
 */
async function initializeHarnessCache() {
    try {
        console.log('🔄 Initializing harness cache...');
        const listCommand = new ListHarnessesCommand({});
        const listResponse = await bedrockAgentCoreControlClient.send(listCommand);

        const harnessesArray = listResponse.harnesses || [];
        console.log(`📋 Found ${harnessesArray.length} harnesses from ListHarnesses API`);

        if (harnessesArray.length > 0) {
            for (const harnessItem of harnessesArray) {
                const harnessId = harnessItem.harnessId;
                const harnessName = harnessItem.harnessName;

                if (!harnessId || !harnessName) {
                    console.log(`⚠️ Harness missing ID or name, skipping`);
                    continue;
                }

                console.log(`🔍 Getting details for harness: ${harnessName} (ID: ${harnessId})`);

                try {
                    // Call GetHarness to get more details including IAM role info
                    const getCommand = new GetHarnessCommand({ harnessId });
                    const harnessDetails = await bedrockAgentCoreControlClient.send(getCommand);

                    console.log(`🔍 GetHarness response keys: ${Object.keys(harnessDetails).join(', ')}`);
                    console.log(`🔍 Harness object keys: ${Object.keys(harnessDetails.harness || {}).join(', ')}`);
                    console.log(`🔍 Full harness response (first 300 chars): ${JSON.stringify(harnessDetails).substring(0, 300)}`);

                    // Try to extract role suffix from the execution role ARN
                    const executionRoleArn = harnessDetails.harness?.executionRoleArn;
                    const harnesId = harnessDetails.harness?.harnessId;

                    if (executionRoleArn) {
                        const iamRoleMatch = executionRoleArn.match(/AmazonBedrockAgentCoreHarnessDefaultServiceRole-([a-z0-9]+)/);
                        if (iamRoleMatch) {
                            const roleSuffix = iamRoleMatch[1];
                            harnessNameCache[roleSuffix] = harnessName;
                            harnessIdCache[roleSuffix] = harnesId;
                            harnessExecutionRoleCache[roleSuffix] = executionRoleArn;
                            console.log(`✅ Mapped role suffix '${roleSuffix}' to harness name '${harnessName}', ID '${harnesId}', and role ARN`);
                        } else {
                            console.log(`⚠️ Role ARN doesn't match expected pattern: ${executionRoleArn}`);
                        }
                    } else {
                        console.log(`⚠️ No executionRoleArn found in GetHarness response for ${harnessName}`);
                    }
                } catch (getError) {
                    console.error(`❌ Error getting details for harness ${harnessId}:`, getError.message);
                }
            }
        }

        console.log(`✅ Harness cache initialized with ${Object.keys(harnessNameCache).length} mappings`);
    } catch (error) {
        console.error('❌ Error initializing harness cache:', error.message);
        // Continue processing even if harness discovery fails - we'll just use identifiers instead of names
    }
}

/**
 * Fetch tags for Lambda function with source indicator
 */
async function getLambdaTags() {
    try {
        if (resourceTagsCache['lambda']) {
            return resourceTagsCache['lambda'];
        }

        const functionArn = `arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:akto-bedrock-log-processor-${AWS_ACCOUNT_ID}`;
        const listTagsCommand = new ListTagsCommand({ Resource: functionArn });
        const response = await lambdaClient.send(listTagsCommand);

        const tags = {};
        if (response.Tags) {
            Object.keys(response.Tags).forEach(key => {
                tags[key] = `${response.Tags[key]}(lambda)`;
            });
        }

        resourceTagsCache['lambda'] = tags;
        console.log(`✅ Lambda tags fetched: ${JSON.stringify(tags).substring(0, 200)}`);
        return tags;
    } catch (error) {
        console.log(`⚠️ Could not fetch Lambda tags: ${error.message}`);
        return {};
    }
}

/**
 * Fetch tags for S3 bucket with source indicator
 */
async function getS3BucketTags(bucketName) {
    try {
        const cacheKey = `s3-${bucketName}`;
        if (resourceTagsCache[cacheKey]) {
            return resourceTagsCache[cacheKey];
        }

        const taggingCommand = new (require('@aws-sdk/client-s3')).GetBucketTaggingCommand({ Bucket: bucketName });
        const response = await s3Client.send(taggingCommand);

        const tags = {};
        if (response.TagSet && Array.isArray(response.TagSet)) {
            response.TagSet.forEach(tag => {
                tags[tag.Key] = `${tag.Value}(s3)`;
            });
        }

        resourceTagsCache[cacheKey] = tags;
        console.log(`✅ S3 bucket tags fetched: ${JSON.stringify(tags).substring(0, 200)}`);
        return tags;
    } catch (error) {
        console.log(`⚠️ Could not fetch S3 tags for ${bucketName}: ${error.message}`);
        return {};
    }
}

/**
 * Fetch tags for Bedrock Agent
 */
async function getBedrockAgentTags(agentId) {
    try {
        const cacheKey = `agent-${agentId}`;
        if (resourceTagsCache[cacheKey]) {
            return resourceTagsCache[cacheKey];
        }

        const agentArn = `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agentId}`;
        const listTagsCommand = new BedrockAgentListTagsCommand({ resourceArn: agentArn });
        const response = await bedrockAgentClient.send(listTagsCommand);

        const tags = {};
        if (response.tags) {
            Object.keys(response.tags).forEach(key => {
                tags[key] = response.tags[key];
            });
        }

        resourceTagsCache[cacheKey] = tags;
        console.log(`✅ Agent tags fetched for ${agentId}: ${JSON.stringify(tags).substring(0, 200)}`);
        return tags;
    } catch (error) {
        console.log(`⚠️ Could not fetch agent tags for ${agentId}: ${error.message}`);
        return {};
    }
}

/**
 * Fetch tags for AgentCore Harness with role/permission info
 */
async function getHarnessTags(harnessId) {
    try {
        const cacheKey = `harness-${harnessId}`;
        if (resourceTagsCache[cacheKey]) {
            return resourceTagsCache[cacheKey];
        }

        const harnessArn = `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:harness/${harnessId}`;
        const listTagsCommand = new BedrockCoreListTagsCommand({ resourceArn: harnessArn });
        const response = await bedrockAgentCoreControlClient.send(listTagsCommand);

        const tags = {};
        if (response.tags) {
            Object.keys(response.tags).forEach(key => {
                tags[key] = response.tags[key];
            });
        }

        resourceTagsCache[cacheKey] = tags;
        console.log(`✅ Harness tags fetched for ${harnessId}: ${JSON.stringify(tags).substring(0, 200)}`);
        return tags;
    } catch (error) {
        console.log(`⚠️ Could not fetch harness tags for ${harnessId}: ${error.message}`);
        return {};
    }
}

/**
 * Add Bedrock agent execution role and permissions to tags
 */
async function addAgentRoleAndPermissions(tags, agentId) {
    try {
        if (!agentId) {
            console.log('⚠️ addAgentRoleAndPermissions: No agent ID provided');
            return tags;
        }

        console.log(`🔍 Fetching execution role for agent: ${agentId}`);
        const getAgentCommand = new GetAgentCommand({ agentId });
        const agentDetails = await bedrockAgentClient.send(getAgentCommand);

        console.log(`🔍 Agent response keys: ${Object.keys(agentDetails).join(', ')}`);
        if (agentDetails.agent) {
            console.log(`🔍 Agent object keys: ${Object.keys(agentDetails.agent).join(', ')}`);
        }

        const agentExecutionRoleArn = agentDetails.agent?.agentRoleArn || agentDetails.agent?.executionRoleArn || '';

        if (!agentExecutionRoleArn) {
            console.log(`⚠️ No execution role found for agent ${agentId}`);
            return tags;
        }

        console.log(`✅ Found agent execution role: ${agentExecutionRoleArn}`);

        const roleName = extractRoleNameFromArn(agentExecutionRoleArn);
        if (!roleName) {
            console.log(`⚠️ Could not extract role name from ARN: ${agentExecutionRoleArn}`);
            return tags;
        }

        const policies = await getRolePolicies(roleName);

        const enhancedTags = {
            ...tags,
            'bedrock-execution-role-arn': agentExecutionRoleArn,
            'bedrock-execution-role': roleName,
            'bedrock-role-policies': policies
        };

        console.log(`✅ Agent role and permissions added to tags`);
        return enhancedTags;
    } catch (error) {
        console.log(`⚠️ Could not add agent role and permissions: ${error.message}`);
        return tags;
    }
}

/**
 * Get configured tools and skills for a harness
 */
async function getHarnessToolsAndSkills(harnessId) {
    try {
        if (!harnessId) {
            console.log('⚠️ getHarnessToolsAndSkills: No harness ID provided');
            return {};
        }

        console.log(`🔍 Fetching tools and skills for harness: ${harnessId}`);
        const getHarnessCommand = new GetHarnessCommand({ harnessId });
        const harnessDetails = await bedrockAgentCoreControlClient.send(getHarnessCommand);

        console.log(`🔍 Harness response keys: ${Object.keys(harnessDetails).join(', ')}`);
        if (harnessDetails.harness) {
            console.log(`🔍 Harness object keys: ${Object.keys(harnessDetails.harness).join(', ')}`);
        }

        const toolsAndSkillsTags = {};

        // Access tools directly from harness object
        const tools = harnessDetails.harness?.tools || [];

        console.log(`🔍 Tools data type: ${Array.isArray(tools) ? 'array' : typeof tools}`);
        console.log(`🔍 Tools data: ${JSON.stringify(tools).substring(0, 500)}`);

        if (tools && Array.isArray(tools) && tools.length > 0) {
            console.log(`✅ Found ${tools.length} configured tools`);

            const toolNames = tools.map(tool => {
                const toolName = tool.toolName || tool.name || tool.toolSpec?.name || 'unknown';
                const toolType = tool.type || tool.toolSpec?.type || 'unknown';
                console.log(`  - Tool: ${toolName} (${toolType})`);
                return `${toolName}:${toolType}`;
            }).join(',');

            if (toolNames) {
                toolsAndSkillsTags['harness-configured-tools'] = toolNames;
            }
        } else {
            console.log(`⚠️ No tools found in harness configuration`);
        }

        // Access skills directly from harness object
        const skills = harnessDetails.harness?.skills || [];

        console.log(`🔍 Skills data type: ${Array.isArray(skills) ? 'array' : typeof skills}`);
        console.log(`🔍 Skills data: ${JSON.stringify(skills).substring(0, 500)}`);

        if (skills && Array.isArray(skills) && skills.length > 0) {
            console.log(`✅ Found ${skills.length} configured skills`);

            const skillEntries = [];
            skills.forEach((skill, index) => {
                const skillKeys = Object.keys(skill);
                console.log(`🔍 Skill ${index} keys: ${skillKeys.join(', ')}`);
                console.log(`🔍 Skill ${index} full object: ${JSON.stringify(skill).substring(0, 300)}`);

                // For each skill, the key IS the skill name/type
                skillKeys.forEach(skillType => {
                    const skillConfig = skill[skillType];

                    // Extract source/url from the config if available
                    let skillSource = 'default';
                    if (skillConfig && typeof skillConfig === 'object') {
                        skillSource = skillConfig.url ||
                                     skillConfig.source ||
                                     skillConfig.sourceType ||
                                     JSON.stringify(skillConfig).substring(0, 50);
                    }

                    console.log(`  - Skill: ${skillType} (${skillSource})`);
                    skillEntries.push(`${skillType}:${skillSource}`);
                });
            });

            const skillNames = skillEntries.join(',');
            if (skillNames) {
                toolsAndSkillsTags['harness-configured-skills'] = skillNames;
            }
        } else {
            console.log(`⚠️ No skills found in harness configuration`);
            console.log(`🔍 Skills array length: ${Array.isArray(skills) ? skills.length : 'not an array'}`);
        }

        console.log(`✅ Tools and skills extracted: ${JSON.stringify(toolsAndSkillsTags).substring(0, 200)}`);
        return toolsAndSkillsTags;
    } catch (error) {
        console.log(`⚠️ Could not fetch harness tools and skills for ${harnessId}: ${error.message}`);
        console.log(`⚠️ Error details: ${JSON.stringify(error).substring(0, 300)}`);
        return {};
    }
}

/**
 * Add harness execution role and permissions to tags
 */
async function addHarnessRoleAndPermissions(tags, harnessExecutionRoleArn) {
    try {
        if (!harnessExecutionRoleArn) {
            return tags;
        }

        const roleName = extractRoleNameFromArn(harnessExecutionRoleArn);
        if (!roleName) {
            return tags;
        }

        const policies = await getRolePolicies(roleName);

        const enhancedTags = {
            ...tags,
            'harness-execution-role-arn': harnessExecutionRoleArn,
            'harness-execution-role': roleName,
            'harness-role-policies': policies
        };

        return enhancedTags;
    } catch (error) {
        console.log(`⚠️ Could not add harness role and permissions: ${error.message}`);
        return tags;
    }
}

/**
 * Fetch Lambda execution role and its attached policies with source indicator
 */
async function getLambdaRoleAndPermissions() {
    try {
        const cacheKey = 'lambda-role-permissions';
        if (resourceTagsCache[cacheKey]) {
            return resourceTagsCache[cacheKey];
        }

        const functionName = `akto-bedrock-log-processor-${AWS_ACCOUNT_ID}`;
        const getFunctionCommand = new GetFunctionCommand({ FunctionName: functionName });
        const functionResponse = await lambdaClient.send(getFunctionCommand);

        const roleArn = functionResponse.Configuration.Role;
        const roleName = roleArn.split('/').pop();

        // Get attached managed policies
        const attachedPoliciesCommand = new ListAttachedRolePoliciesCommand({ RoleName: roleName });
        const attachedPolicies = await iamClient.send(attachedPoliciesCommand);

        const policyNames = attachedPolicies.AttachedPolicies?.map(p => p.PolicyName).join(',') || '';

        const roleInfo = {
            'lambda-execution-role': `${roleName}(lambda)`,
            'lambda-execution-role-arn': `${roleArn}(lambda)`,
            'lambda-attached-policies': `${policyNames}(lambda)`
        };

        resourceTagsCache[cacheKey] = roleInfo;
        console.log(`✅ Lambda role and permissions fetched: ${JSON.stringify(roleInfo).substring(0, 200)}`);
        return roleInfo;
    } catch (error) {
        console.log(`⚠️ Could not fetch Lambda role and permissions: ${error.message}`);
        return {};
    }
}

/**
 * Extract role name from IAM role ARN
 */
function extractRoleNameFromArn(roleArn) {
    if (!roleArn) return '';
    const parts = roleArn.split('/');
    return parts[parts.length - 1];
}

/**
 * Fetch attached policies for a role
 */
async function getRolePolicies(roleName) {
    try {
        const cacheKey = `role-policies-${roleName}`;
        if (resourceTagsCache[cacheKey]) {
            return resourceTagsCache[cacheKey];
        }

        const attachedPoliciesCommand = new ListAttachedRolePoliciesCommand({ RoleName: roleName });
        const attachedPolicies = await iamClient.send(attachedPoliciesCommand);

        const policyNames = attachedPolicies.AttachedPolicies?.map(p => p.PolicyName).join(',') || '';

        resourceTagsCache[cacheKey] = policyNames;
        console.log(`✅ Role policies fetched for ${roleName}: ${policyNames}`);
        return policyNames;
    } catch (error) {
        console.log(`⚠️ Could not fetch policies for role ${roleName}: ${error.message}`);
        return '';
    }
}

/**
 * Detect whether log is from regular Bedrock Agent or AgentCore Harness
 */
function detectLogType(arn) {
    if (!arn) return 'UNKNOWN';

    if (arn.includes('BedrockAgents-')) {
        return 'AGENT';
    } else if (arn.includes('AmazonBedrockAgentCoreHarnessDefaultServiceRole-')) {
        return 'HARNESS';
    }

    return 'UNKNOWN';
}

/**
 * Extract harness role suffix from ARN (e.g., 'fr53w' from role name suffix)
 */
function extractHarnessRoleSuffix(arn) {
    if (!arn) return '';

    // Pattern: AmazonBedrockAgentCoreHarnessDefaultServiceRole-{SUFFIX}/...
    const match = arn.match(/AmazonBedrockAgentCoreHarnessDefaultServiceRole-([a-z0-9]+)/);
    return match ? match[1] : '';
}

/**
 * Get harness name from role suffix (using cached mapping)
 */
function getHarnessName(roleSuffix) {
    if (!roleSuffix) return '';

    const name = harnessNameCache[roleSuffix];
    if (name) {
        console.log(`✅ Found harness name in cache: ${name} (role suffix: ${roleSuffix})`);
        return name;
    }

    console.log(`⚠️ Harness name not found in cache for role suffix: ${roleSuffix}`);
    return '';
}

/**
 * Get harness ID from role suffix (using cached mapping)
 */
function getHarnessId(roleSuffix) {
    if (!roleSuffix) return '';

    const id = harnessIdCache[roleSuffix];
    if (id) {
        console.log(`✅ Found harness ID in cache: ${id} (role suffix: ${roleSuffix})`);
        return id;
    }

    console.log(`⚠️ Harness ID not found in cache for role suffix: ${roleSuffix}`);
    return '';
}

/**
 * Get harness execution role ARN from role suffix (using cached mapping)
 */
function getHarnessExecutionRoleArn(roleSuffix) {
    if (!roleSuffix) return '';

    const arn = harnessExecutionRoleCache[roleSuffix];
    if (arn) {
        console.log(`✅ Found harness execution role ARN in cache: ${arn} (role suffix: ${roleSuffix})`);
        return arn;
    }

    console.log(`⚠️ Harness execution role ARN not found in cache for role suffix: ${roleSuffix}`);
    return '';
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