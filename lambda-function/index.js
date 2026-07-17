const {
    BedrockClient,
    GetModelInvocationLoggingConfigurationCommand
} = require('@aws-sdk/client-bedrock');
const { BedrockAgentClient, GetAgentCommand, ListAgentsCommand, ListTagsForResourceCommand: BedrockAgentListTagsCommand } = require('@aws-sdk/client-bedrock-agent');
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
const LOGS_BUCKET_NAME = process.env.LOGS_BUCKET_NAME;
const LOGS_PREFIX = process.env.LOGS_PREFIX || 'AWSLogs/'; // Default to AWS-created folder for model invocation logging
const MARKERS_BUCKET_NAME = process.env.MARKERS_BUCKET_NAME;
const AWS_REGION = process.env.BEDROCK_AWS_REGION || process.env.AWS_REGION;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const MARKERS_PREFIX = 'akto/markers/'; // Hardcoded prefix for marker files

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

// Manifest for timestamp-based tracking (replaces per-file markers)
const MANIFEST_KEY = `${MARKERS_PREFIX}bedrock-logs/manifest.json`;

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
        // Step 1: Determine paths for logs and markers
        const { logsBucket, logsPrefix, markersBucket, markersPrefix } = await determinePaths();

        // Step 2: Load manifest for timestamp-based tracking
        console.log('📖 Loading manifest for timestamp-based processing...');
        const manifest = await getManifest(markersBucket);

        // Step 3: Get unprocessed log files from S3 (using timestamp filtering)
        const unprocessedFiles = await getUnprocessedLogFiles(logsBucket, logsPrefix, manifest);
        console.log(`📁 Found ${unprocessedFiles.length} unprocessed log files`);

        // Step 4: DISCOVER ALL AGENTS FIRST (metadata-first approach)
        // This ensures all agents are known on day 1, before processing any conversations
        console.log('\n📋 Step 1: Discovering all agents and harnesses...');
        const { agentDiscoveryMessages, discoveredAgents } =
            await discoverAllNewAgents(manifest);
        console.log(`✅ Discovery complete: ${agentDiscoveryMessages.length} new agents found`);

        // Step 5: Process each log file and collect conversation messages
        let conversationMessages = [];
        let processedFiles = 0;
        let lastProcessedFileTimestamp = manifest.lastProcessedTimestamp;  // Track LAST file's timestamp

        if (unprocessedFiles.length === 0) {
            console.log('\n✅ No new log files to process');
            // Still send discovery messages if any new agents found
            if (agentDiscoveryMessages.length > 0) {
                await sendToDataIngestionService(agentDiscoveryMessages);
                await updateManifest(markersBucket, markersPrefix, 0, agentDiscoveryMessages.length, discoveredAgents, lastProcessedFileTimestamp);
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: 'No new log files to process',
                    bucket: logsBucket,
                    processedFiles: 0,
                    agentDiscoveriesCreated: agentDiscoveryMessages.length
                })
            };
        }

        for (const file of unprocessedFiles) {
            try {
                console.log(`\n🔄 Processing file: ${file.Key}`);
                const messages = await processLogFile(logsBucket, file.Key);

                if (messages.length > 0) {
                    conversationMessages.push(...messages);
                }

                processedFiles++;

                // Example: File A (10:05), File B (10:03), File C (10:04) - we must track max (10:05)
                const fileTimestamp = new Date(file.LastModified).toISOString();
                if (!lastProcessedFileTimestamp || fileTimestamp > lastProcessedFileTimestamp) {
                    lastProcessedFileTimestamp = fileTimestamp;
                }
                console.log(`✅ File processed successfully: ${file.Key} (${messages.length} messages) [LastModified: ${fileTimestamp}, Max: ${lastProcessedFileTimestamp}]`);

            } catch (error) {
                console.error(`❌ Error processing file ${file.Key}:`, error);
                // Continue processing other files even if one fails
            }
        }

        console.log(`\n📊 Total conversation messages: ${conversationMessages.length}`);

        // Step 6: Combine all messages (discovery already done in Step 4)
        // Discovery messages go first, then conversation messages enhance them
        const allMessages = [...agentDiscoveryMessages, ...conversationMessages];
        console.log(`🎯 Total messages to send: ${allMessages.length} (discovery: ${agentDiscoveryMessages.length}, conversations: ${conversationMessages.length})`);


        // If sending fails (502 error), manifest is already persisted
        // This prevents infinite re-processing on API failures!
        console.log('\n📝 Updating manifest with new processing timestamp and discovered agents...');
        await updateManifest(markersBucket, markersPrefix, processedFiles, allMessages.length, discoveredAgents, lastProcessedFileTimestamp);
        console.log('✅ Manifest updated successfully');

        // Step 7: Send all messages to AKTO (after manifest is safe)
        if (allMessages.length > 0) {
            console.log('\n📤 Sending messages to AKTO ingestion API...');
            await sendToDataIngestionService(allMessages);
            console.log('✅ Messages sent to AKTO');
        } else {
            console.log('✅ No messages to send to AKTO');
        }

        console.log(`\n🎉 Processing completed successfully`);
        console.log(`📊 Summary:`);
        console.log(`   - Agent discovery: ${agentDiscoveryMessages.length} agents`);
        console.log(`   - Files processed: ${processedFiles}`);
        console.log(`   - Conversation messages: ${conversationMessages.length}`);
        console.log(`   - Total messages sent: ${allMessages.length}`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Processing completed successfully',
                logsBucket: logsBucket,
                markersBucket: markersBucket,
                processedFiles: processedFiles,
                conversationMessages: conversationMessages.length,
                agentDiscoveriesCreated: agentDiscoveryMessages.length,
                totalMessages: allMessages.length
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
 * Validate and return S3 paths for logs and markers
 */
async function determinePaths() {
    try {
        // Validate inputs
        if (!LOGS_BUCKET_NAME || !LOGS_BUCKET_NAME.trim()) {
            throw new Error('LOGS_BUCKET_NAME environment variable is required');
        }

        if (!LOGS_PREFIX || !LOGS_PREFIX.trim()) {
            throw new Error('LOGS_PREFIX environment variable is required');
        }

        if (!MARKERS_BUCKET_NAME || !MARKERS_BUCKET_NAME.trim()) {
            throw new Error('MARKERS_BUCKET_NAME environment variable is required');
        }

        console.log(`📖 Logs bucket: ${LOGS_BUCKET_NAME}, prefix: ${LOGS_PREFIX}`);
        console.log(`📍 Markers bucket: ${MARKERS_BUCKET_NAME}, prefix: ${MARKERS_PREFIX}`);

        return {
            logsBucket: LOGS_BUCKET_NAME,
            logsPrefix: LOGS_PREFIX,
            markersBucket: MARKERS_BUCKET_NAME,
            markersPrefix: MARKERS_PREFIX
        };

    } catch (error) {
        console.error('❌ Error validating paths:', error);
        throw error;
    }
}

/**
 * Get manifest file that tracks last processed timestamp
 */
async function getManifest(markersBucket) {
    try {
        console.log(`📖 Reading manifest from ${markersBucket}/${MANIFEST_KEY}`);
        const response = await s3Client.send(new GetObjectCommand({
            Bucket: markersBucket,
            Key: MANIFEST_KEY
        }));

        // ✅ FIX: Properly read S3 GetObjectCommand stream
        const chunks = [];
        for await (const chunk of response.Body) {
            chunks.push(chunk);
        }
        const manifestText = Buffer.concat(chunks).toString('utf-8');
        const manifest = JSON.parse(manifestText);
        console.log(`✅ Manifest loaded: lastProcessedTimestamp=${manifest.lastProcessedTimestamp}`);
        return manifest;

    } catch (error) {
        if (error.name === 'NoSuchKey') {
            console.log('📝 No manifest found - first run. Will start from 7 days ago');
            return {};  // Return empty object, not null!
        }
        console.warn(`⚠️ Error reading manifest: ${error.message}`);
        return {};  // Return empty object on error, not null!
    }
}

/**
 * Update manifest with new processing timestamp and file count
 * @param {string} lastProcessedFileTimestamp - The LastModified timestamp of the LAST file we processed (not Lambda end time)
 */
async function updateManifest(markersBucket, markersPrefix, filesProcessed, messagesExtracted, discoveredAgents, lastProcessedFileTimestamp) {
    try {
        // ✅ FIX: Use the LAST file's LastModified timestamp, not the current time
        // This prevents re-processing of already-processed files during partial runs
        const timestampToStore = lastProcessedFileTimestamp || new Date().toISOString();

        const manifest = {
            version: '2.1',
            lastProcessedTimestamp: timestampToStore,
            filesProcessedCount: filesProcessed,
            totalMessagesExtracted: messagesExtracted,
            lastManifestUpdate: new Date().toISOString(),
            discoveredAgents: discoveredAgents || {}
        };

        await s3Client.send(new PutObjectCommand({
            Bucket: markersBucket,
            Key: MANIFEST_KEY,
            Body: JSON.stringify(manifest, null, 2),
            ContentType: 'application/json'
        }));

        const agentCount = Object.keys(discoveredAgents || {}).length;
        console.log(`✅ Manifest updated: ${filesProcessed} files, ${messagesExtracted} messages, ${agentCount} discovered agents`);
        console.log(`   └─ lastProcessedTimestamp: ${timestampToStore}`);

    } catch (error) {
        console.error(`❌ Error updating manifest: ${error.message}`);
        // Don't throw - manifest update failure shouldn't block log processing
    }
}

/**
 * Determine the timestamp to start processing from (manifest or 7 days ago)
 */
function getLogsStartTime(manifest) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    if (manifest && manifest.lastProcessedTimestamp) {
        const lastRun = new Date(manifest.lastProcessedTimestamp);

        // If last run is within 7-day window, resume from there
        if (lastRun > sevenDaysAgo) {
            console.log(`✅ Starting from last successful run: ${manifest.lastProcessedTimestamp}`);
            return lastRun;
        } else {
            console.log(`⚠️ Last run (${manifest.lastProcessedTimestamp}) is older than 7 days`);
            console.log(`   Resetting to 7 days ago: ${sevenDaysAgo.toISOString()}`);
            return sevenDaysAgo;
        }
    }

    console.log(`📝 First run detected. Starting from ${sevenDaysAgo.toISOString()}`);
    return sevenDaysAgo;
}

/**
 * Get list of unprocessed log files from S3 using manifest-based timestamp filtering
 * Uses simple prefix search (works with AWS Bedrock log structure) + manifest timestamps
 */
async function getUnprocessedLogFiles(logsBucket, logsPrefix, manifest) {
    try {
        const s3Path = `s3://${logsBucket}/${logsPrefix}`;
        console.log(`📁 Scanning S3 bucket for new log files: ${s3Path}`);

        // Determine start time from manifest or default to 7 days ago
        const startTime = getLogsStartTime(manifest);

        // Simple approach: List all files under prefix recursively (OLD working approach)
        // This works because S3 ListObjectsV2 returns ALL objects under a prefix recursively
        let allFiles = [];
        let continuationToken = null;

        do {
            const response = await s3Client.send(new ListObjectsV2Command({
                Bucket: logsBucket,
                Prefix: logsPrefix,
                ContinuationToken: continuationToken,
                MaxKeys: 1000
            }));

            const objects = response.Contents || [];
            allFiles.push(...objects);

            if (objects.length > 0) {
                console.log(`📄 Listed ${objects.length} objects (${allFiles.length} total)`);
            }

            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        console.log(`📊 Found ${allFiles.length} total files in prefix`);

        // Filter for .gz files only
        let logFiles = allFiles.filter(file =>
            file.Key.endsWith('.gz') && file.Size > 0
        );

        console.log(`📦 Found ${logFiles.length} .gz log files`);


        // S3 returns files in random order, so we must sort for chronological processing
        logFiles.sort((a, b) =>
            new Date(a.LastModified).getTime() - new Date(b.LastModified).getTime()
        );

        // Filter by timestamp: only process files modified AFTER startTime (strictly greater than)

        const unprocessedFiles = logFiles.filter(file => {
            if (!file.LastModified) return true;
            return new Date(file.LastModified) > startTime;
        });

        console.log(`🆕 Found ${unprocessedFiles.length} files to process (modified after ${startTime.toISOString()})`);
        return unprocessedFiles;

    } catch (error) {
        console.error('❌ Error listing S3 files:', error);
        return [];
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
 * List all agents in the AWS account
 */
async function listAllAgents() {
    try {
        console.log('📋 Listing all agents in account...');
        const response = await bedrockAgentClient.send(new ListAgentsCommand({}));
        const agents = response.agentSummaries || [];
        console.log(`✅ Found ${agents.length} agents in account`);
        return agents;
    } catch (error) {
        console.error('❌ Error listing agents:', error.message);
        console.log('⚠️ Agents will not be discovered in this run (may require bedrock:ListAgents permission)');
        return [];
    }
}

/**
 * Get detailed agent metadata by agent ID
 */
async function getAgentMetadata(agentId) {
    try {
        const response = await bedrockAgentClient.send(new GetAgentCommand({ agentId }));
        return response.agent;
    } catch (error) {
        console.error(`❌ Error fetching agent metadata for ${agentId}:`, error.message);
        return null;
    }
}

/**
 * List all harnesses in the AWS account
 */
async function listAllHarnesses() {
    try {
        console.log('📋 Listing all harnesses in account...');
        const response = await bedrockAgentCoreControlClient.send(new ListHarnessesCommand({}));
        // ✅ FIX: Response field is "harnesses", not "harnessSummaries"
        const harnesses = response.harnesses || [];
        console.log(`✅ Found ${harnesses.length} harnesses in account`);
        return harnesses;
    } catch (error) {
        console.error('❌ Error listing harnesses:', error.message);
        return [];
    }
}

/**
 * Get detailed harness metadata by harness ID
 */
async function getHarnessMetadata(harnessId) {
    try {
        const response = await bedrockAgentCoreControlClient.send(new GetHarnessCommand({ harnessId }));
        return response.harness;
    } catch (error) {
        console.error(`❌ Error fetching harness metadata for ${harnessId}:`, error.message);
        return null;
    }
}

/**
 * Create unified message builder for both conversation and discovery data
 * Consolidates createStandardMessage and createMetadataOnlyMessage logic
 */
function buildAgentMessage(data, isConversation) {
    const timestamp = isConversation
        ? Math.floor(new Date(data.timestamp).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

    const originalHost = `bedrock-runtime.${AWS_REGION}.amazonaws.com`;

    // Determine modelId and agent/harness ID based on conversation or discovery
    let modelId, agentOrHarnessId, resourceName;
    if (isConversation) {
        modelId = data.modelId;
        agentOrHarnessId = data.agentId;
        resourceName = data.botName;
    } else {
        // ✅ FIX: Discovery must use foundationModel (like "amazon.nova-micro-v1:0"), not agent/harness ID
        modelId = data.foundationModel || 'unknown-model';
        agentOrHarnessId = data.resourceType === 'HARNESS' ? data.harnessId : data.agentId;
        resourceName = data.resourceType === 'HARNESS' ? data.harnessName : data.agentName;
    }

    // Unified request headers (same for conversation and discovery)
    const requestHeaders = {
        'Content-Type': 'application/json',
        'X-Bedrock-Model-Id': modelId,  // ✅ FIX: Now uses foundationModel for discovery
        'bedrock-agent-id': agentOrHarnessId || '',
        'agent-name': resourceName || '',
        'bedrock-region': isConversation ? (data.region || AWS_REGION) : AWS_REGION,
        'host': originalHost  // ✅ FIX: Always include host header (not just for conversation)
    };

    // Add conversation-specific headers only if conversation
    if (isConversation) {
        requestHeaders['Authorization'] = 'AWS4-HMAC-SHA256';
        requestHeaders['X-Request-Id'] = data.requestId;
        requestHeaders['bedrock-operation'] = data.operation || 'Unknown';
        requestHeaders['bedrock-identity-arn'] = data.arn || '';
        requestHeaders['bedrock-input-tokens'] = (data.inputTokenCount || 0).toString();
        requestHeaders['bedrock-output-tokens'] = (data.outputTokenCount || 0).toString();
        requestHeaders['aws-account-id'] = data.accountId || AWS_ACCOUNT_ID;
    } else {
        // Discovery headers (shared structure with conversation)
        requestHeaders['bedrock-operation'] = 'DISCOVERY';
        requestHeaders['bedrock-identity-arn'] = data.arn || '';
        requestHeaders['aws-account-id'] = AWS_ACCOUNT_ID;
    }

    // Unified request payload (different content based on type)
    let requestPayload;
    if (isConversation) {
        requestPayload = {
            message: data.userMessage,
            model: data.modelId,
            requestId: data.requestId
        };
    } else {
        // Discovery payload - handle both agents and harnesses
        const resourceId = data.resourceType === 'HARNESS' ? data.harnessId : data.agentId;
        const resourceName = data.resourceType === 'HARNESS' ? data.harnessName : data.agentName;

        requestPayload = {
            resourceId: resourceId,
            resourceName: resourceName,
            resourceType: data.resourceType,
            description: data.description || '',
            status: data.agentStatus,
            foundationModel: data.foundationModel,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            executionRoleArn: data.resourceType === 'HARNESS' ? data.executionRoleArn : data.agentResourceRoleArn
        };
    }

    // Unified response payload (empty for discovery)
    const responsePayload = isConversation
        ? {
            message: data.agentResponse,
            model: data.modelId
        }
        : {};

    // Unified tag structure
    const baseTags = {
        source: 'AWS_BEDROCK',
        'gen-ai': 'Gen AI',
        'account-id': isConversation ? (data.accountId || AWS_ACCOUNT_ID) : AWS_ACCOUNT_ID,
        'region': isConversation ? (data.region || AWS_REGION) : AWS_REGION
    };

    const conversationTags = isConversation ? {
        'agentType': data.logType === 'AGENT' ? 'BEDROCK_AGENT' : (data.logType === 'HARNESS' ? 'AGENTCORE_AGENT' : 'UNKNOWN'),
        'bot-name': data.botName,
        'operation': data.operation || 'Unknown',
        'agent-id': data.logType === 'AGENT' ? (data.agentId || '') : '',
        'harness-id': data.logType === 'HARNESS' ? (data.harnessId || '') : '',
        'model': data.modelId,
        'input-tokens': (data.inputTokenCount || 0).toString(),
        'output-tokens': (data.outputTokenCount || 0).toString(),
        'bedrock-identity-arn': data.arn || '',
        ...(data.logType === 'AGENT' ? data.agentTags : data.harnessTags)  // ← Include enriched tags
    } : {
        // Discovery: Determine agent type (BEDROCK_AGENT or AGENTCORE_AGENT)
        'agentType': data.resourceType === 'HARNESS' ? 'AGENTCORE_AGENT' : 'BEDROCK_AGENT',
        'bot-name': data.resourceType === 'HARNESS' ? data.harnessName : data.agentName,
        'agent-id': data.resourceType === 'AGENT' ? (data.agentId || '') : '',
        'harness-id': data.resourceType === 'HARNESS' ? (data.harnessId || '') : '',
        'model': data.foundationModel,
        'discovery-type': 'METADATA_ONLY',
        'has-conversations': 'false',  // ✅ FIX: String instead of boolean
        'bedrock-identity-arn': data.arn || '',  // ← Now include ARN for discovered resources
        ...(data.resourceType === 'AGENT' ? (data.agentTags || {}) : (data.harnessTags || {}))  // ← Include enriched tags
    };

    const tags = { ...baseTags, ...conversationTags };

    // Unified message structure
    const message = {
        path: `/model/${modelId}/invoke`,  // ✅ FIX: Always include path (same for discovery and conversation)
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify(requestHeaders),
        responseHeaders: JSON.stringify({
            'Content-Type': 'application/json',
            ...(isConversation && { 'X-Request-Id': data.requestId })
        }),
        requestPayload: JSON.stringify(requestPayload),
        responsePayload: JSON.stringify(responsePayload),
        ip: '0.0.0.0',
        time: timestamp.toString(),
        statusCode: '200',
        type: 'HTTP',
        status: 'OK',
        akto_account_id: '1000000',
        akto_vxlan_id: '0',
        is_pending: 'false',
        source: 'MIRRORING',
        tag: JSON.stringify(tags),
        awsMetadata: JSON.stringify(
            isConversation
                ? data.awsMetadata  // Use pre-built awsMetadata from createStandardMessage
                : {
                    agentStatus: data.agentStatus,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt
                }
        )
    };

    return message;
}

/**
 * Discover all agents and harnesses not yet in manifest
 *
 * METADATA-FIRST APPROACH:
 * - Discovers ALL agents on day 1 (before any conversations)
 * - Subsequent runs only discover NEW agents added to account
 * - Ensures AKTO sees complete inventory from start
 *
 * Logic:
 * - List all agents/harnesses in account
 * - For each one NOT in manifest:
 *   ✓ Fetch metadata, tags, execution role
 *   ✓ Create discovery message (metadata only)
 *   ✓ Add to manifest (prevents re-discovery)
 * - Conversation messages will overlay on top later (same fields)
 */
async function discoverAllNewAgents(manifest) {
    try {
        const discoveredAgents = manifest.discoveredAgents || {};
        const agentDiscoveryMessages = [];
        const newDiscoveredAgents = { ...discoveredAgents };

        // === DISCOVER BEDROCK AGENTS ===
        console.log('\n🤖 Discovering Bedrock agents...');
        const allAgents = await listAllAgents();
        console.log(`📋 Found ${allAgents.length} agents in account`);

        for (const agent of allAgents) {
            const resourceKey = `agent-${agent.agentId}`;

            // Simple check: Is this agent already in manifest?
            if (discoveredAgents[resourceKey]) {
                console.log(`  ⏭️ Agent ${agent.agentName} already processed`);
                continue;  // Already processed (either has conversation or already discovered)
            }

            // NEW agent - create discovery message
            try {
                console.log(`  🔍 Discovering: ${agent.agentName} (${agent.agentId})`);
                const metadata = await getAgentMetadata(agent.agentId);

                if (metadata) {
                    // Enrich with tags and role information
                    let agentTags = await getBedrockAgentTags(agent.agentId);
                    agentTags = await addAgentRoleAndPermissions(agentTags, agent.agentId);

                    // Build ARN
                    const agentArn = metadata.agentArn || `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agent.agentId}`;

                    // Prepare enriched data for message builder
                    const enrichedData = {
                        ...metadata,
                        resourceType: 'AGENT',
                        arn: agentArn,
                        agentTags: agentTags,
                        harnessTags: {}
                    };

                    const message = buildAgentMessage(enrichedData, false);
                    agentDiscoveryMessages.push(message);

                    // Add to manifest
                    newDiscoveredAgents[resourceKey] = {
                        resourceId: agent.agentId,
                        resourceType: 'AGENT',
                        resourceName: agent.agentName,
                        foundationModel: metadata.foundationModel,
                        discoveredAt: new Date().toISOString()
                    };

                    console.log(`  ✅ Created discovery message for: ${agent.agentName}`);
                }
            } catch (error) {
                console.error(`  ⚠️ Error processing agent ${agent.agentId}:`, error.message);
            }
        }

        // === DISCOVER HARNESSES (AGENTCORE) ===
        console.log('\n🏗️ Discovering harnesses...');
        const allHarnesses = await listAllHarnesses();
        console.log(`📋 Found ${allHarnesses.length} harnesses in account`);

        for (const harness of allHarnesses) {
            const resourceKey = `harness-${harness.harnessId}`;

            // Simple check: Is this harness already in manifest?
            if (discoveredAgents[resourceKey]) {
                console.log(`  ⏭️ Harness ${harness.harnessName} already processed`);
                continue;  // Already processed
            }

            // NEW harness - create discovery message
            try {
                console.log(`  🔍 Discovering: ${harness.harnessName} (${harness.harnessId})`);
                const metadata = await getHarnessMetadata(harness.harnessId);

                if (metadata) {
                    // Enrich with tags and role information
                    let harnessTags = await getHarnessTags(harness.harnessId);

                    if (metadata.executionRoleArn) {
                        harnessTags = await addHarnessRoleAndPermissions(harnessTags, metadata.executionRoleArn);
                    }

                    // Build ARN
                    const harnessArn = metadata.harnessArn || `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:harness/${harness.harnessId}`;

                    // Prepare enriched data for message builder
                    const enrichedData = {
                        ...metadata,
                        resourceType: 'HARNESS',
                        harnessId: harness.harnessId,
                        harnessName: harness.harnessName,
                        arn: harnessArn,
                        agentTags: {},
                        harnessTags: harnessTags,
                        agentStatus: metadata.harnessStatus || 'PREPARED',
                        foundationModel: metadata.foundationModel || 'N/A'
                    };

                    const message = buildAgentMessage(enrichedData, false);
                    agentDiscoveryMessages.push(message);

                    // Add to manifest
                    newDiscoveredAgents[resourceKey] = {
                        resourceId: harness.harnessId,
                        resourceType: 'HARNESS',
                        resourceName: harness.harnessName,
                        foundationModel: metadata.foundationModel || 'N/A',
                        discoveredAt: new Date().toISOString()
                    };

                    console.log(`  ✅ Created discovery message for: ${harness.harnessName}`);
                }
            } catch (error) {
                console.error(`  ⚠️ Error processing harness ${harness.harnessId}:`, error.message);
            }
        }

        console.log(`\n✨ Created ${agentDiscoveryMessages.length} discovery messages`);
        return { agentDiscoveryMessages, discoveredAgents: newDiscoveredAgents };

    } catch (error) {
        console.error('❌ Error in discovery:', error.message);
        // ✅ FIX: Return newDiscoveredAgents instead of empty object to preserve discovered agents
        return { agentDiscoveryMessages: [], discoveredAgents: newDiscoveredAgents };
    }
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

    // Prepare enriched data object for unified message builder
    const enrichedData = {
        // Shared fields
        timestamp: pair.timestamp,
        modelId: pair.modelId,
        agentId: pair.agentId,
        accountId: pair.accountId || AWS_ACCOUNT_ID,
        region: pair.region || AWS_REGION,
        arn: pair.arn || '',

        // Conversation-specific fields
        requestId: pair.requestId,
        userMessage: pair.userMessage,
        agentResponse: pair.agentResponse,
        botName: botName,
        operation: pair.operation || 'Unknown',
        inputTokenCount: pair.inputTokenCount || 0,
        outputTokenCount: pair.outputTokenCount || 0,
        harnessId: pair.harnessId || '',
        logType: pair.logType,
        harnessRoleSuffix: pair.harnessRoleSuffix,
        traceData: pair.traceData || {},

        // Tags (for tag enrichment in unified builder)
        agentTags: agentTags,
        harnessTags: harnessTags,
        awsMetadata: awsMetadata
    };

    // Build message using unified builder
    return buildAgentMessage(enrichedData, true);
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

    if (messages.length === 0) {
        console.log('⚠️ No messages to send');
        return { status: 'skipped', message: 'No messages' };
    }

    try {
        // Batch messages into chunks of 1000 for efficiency and timeout prevention
        const BATCH_SIZE = 1000;
        const totalBatches = Math.ceil(messages.length / BATCH_SIZE);

        console.log(`📦 Splitting into ${totalBatches} batch(es) of up to ${BATCH_SIZE} messages`);

        // Process batches sequentially to avoid overwhelming the API
        const results = [];
        for (let i = 0; i < messages.length; i += BATCH_SIZE) {
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const batch = messages.slice(i, i + BATCH_SIZE);

            console.log(`\n📨 Sending batch ${batchNum}/${totalBatches} (${batch.length} messages)`);

            // Log batch details (first batch full, others summarized)
            if (batchNum === 1) {
                console.log('📤 AKTO FORMAT JSON - First batch data being sent:');
                console.log('='.repeat(60));
                batch.forEach((msg, index) => {
                    console.log(`🔹 Message ${index + 1}:`);
                    console.log(JSON.stringify(msg, null, 2));
                    if (index < 2 && batch.length > 3) console.log('---');  // Show first 2, ellipsis if more
                });
                if (batch.length > 3) {
                    console.log(`... (${batch.length - 3} more messages in this batch)`);
                }
                console.log('='.repeat(60));
            } else {
                console.log(`✓ Batch contains ${batch.length} messages (not logging to save output)`);
            }

            const payload = { batchData: batch };
            const response = await fetch(DATA_INGESTION_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': process.env.AKTO_API_KEY || '',
                    'User-Agent': 'AKTO-Bedrock-Monitor/2.0'
                },
                body: JSON.stringify(payload)
            });

            console.log(`📊 Batch ${batchNum} - Response status: ${response.status} ${response.statusText}`);

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`❌ HTTP error in batch ${batchNum}: ${response.status}`);
                console.error('Response:', errorText);
                throw new Error(`HTTP error in batch ${batchNum}! status: ${response.status}, body: ${errorText}`);
            }

            const result = await response.json();
            results.push(result);
            console.log(`✅ Batch ${batchNum} sent successfully`);
        }

        console.log(`\n🎉 All ${totalBatches} batch(es) sent successfully to data ingestion service`);
        return { status: 'success', totalBatches, totalMessages: messages.length, results };

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