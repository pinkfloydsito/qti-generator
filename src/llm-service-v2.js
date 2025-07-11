import ProviderFactory from './llm-providers/provider-factory.js';
import ConfigManager from './config/config-manager.js';
import ApiKeyCache from './services/api-key-cache.js';

import log from 'electron-log/main.js';

/**
 * Enhanced LLM Service with SOLID architecture
 * Supports multiple providers with clean separation of concerns
 */
class LLMService {
  constructor() {
    this.configManager = new ConfigManager();
    this.apiKeyCache = new ApiKeyCache(this.configManager);
    this.currentProvider = null;
    this.providerName = null;
    this.fallbackProviders = [];

    // Default configuration
    this.config = {
      primaryProvider: 'gemini',
      fallbackProviders: ['mistral', 'deepseek', 'huggingface'],
      autoFallback: true,
      maxRetries: 3
    };
  }

  /**
   * Set the primary provider and configure it
   * @param {string} providerName - Name of the provider
   * @param {string} apiKey - API key for the provider
   * @param {Object} options - Additional configuration options
   */
  async setProvider(providerName, apiKey, options = {}) {
    try {
      // Create and configure the provider
      this.currentProvider = ProviderFactory.createProvider(providerName);
      await this.currentProvider.configure(apiKey, options);

      this.providerName = providerName;

      // Cache the API key if validation successful
      if (await this.currentProvider.testApiKey()) {
        await this.apiKeyCache.setApiKey(providerName, apiKey, () => this.currentProvider.testApiKey());
        log.info(`✅ ${providerName} provider configured and validated successfully`);
      } else {
        log.debug(`⚠️  ${providerName} provider configured but API key validation failed`);
      }

    } catch (error) {
      log.error(`❌ Failed to configure ${providerName} provider:`, error.message);
      throw new Error(`Failed to configure ${providerName} provider: ${error.message}`);
    }
  }

  /**
   * Configure fallback providers for automatic failover
   * @param {Array<Object>} fallbackConfigs - Array of {provider, apiKey} objects
   */
  async configureFallbackProviders(fallbackConfigs) {
    this.fallbackProviders = [];

    for (const config of fallbackConfigs) {
      try {
        const provider = ProviderFactory.createProvider(config.provider);
        await provider.configure(config.apiKey, config.options || {});

        this.fallbackProviders.push({
          name: config.provider,
          provider: provider,
          isValid: await provider.testApiKey()
        });

        log.info(`📋 Fallback provider ${config.provider} configured`);
      } catch (error) {
        log.warn(`⚠️  Failed to configure fallback provider ${config.provider}:`, error.message);
      }
    }

    log.info(`🔄 Configured ${this.fallbackProviders.length} fallback providers`);
  }

  /**
   * Generate questions using the configured provider with automatic fallback
   * @param {string} context - The content context for question generation
   * @param {Object} options - Generation options
   * @returns {Promise<Array>} Array of generated questions
   */
  async generateQuestions(context, options = {}) {
    const {
      questionCount = 5,
      difficulty = 'medium',
      questionTypes = ['multiple_choice'],
      includeMath = true,
      maxRetries = this.config.maxRetries
    } = options;

    const prompt = this.buildPrompt(context, {
      questionCount,
      difficulty,
      questionTypes,
      includeMath
    });

    // Try primary provider first
    if (this.currentProvider) {
      try {
        log.info(`🎯 Attempting generation with primary provider: ${this.providerName}`);
        const questions = await this.currentProvider.generateQuestions(prompt, options);
        return this.validateAndProcessQuestions(questions);
      } catch (error) {
        log.warn(`❌ Primary provider ${this.providerName} failed:`, error.message);

        if (!this.config.autoFallback) {
          throw error;
        }
      }
    }

    // Try fallback providers if auto-fallback is enabled
    if (this.config.autoFallback && this.fallbackProviders.length > 0) {
      log.info('🔄 Attempting fallback providers...');

      for (const fallback of this.fallbackProviders) {
        if (!fallback.isValid) {
          log.info(`⏭️  Skipping invalid fallback provider: ${fallback.name}`);
          continue;
        }

        try {
          log.info(`🎯 Attempting generation with fallback provider: ${fallback.name}`);
          log.info(`📤 Sending request to fallback provider: ${fallback.name}`);

          const questions = await fallback.provider.generateQuestions(prompt, options);
          log.info(`📥 Received response from ${fallback.name}`);
          log.info('🔍 Validating and processing questions...');

          const processedQuestions = this.validateAndProcessQuestions(questions);

          log.info(`✅ Successfully generated ${processedQuestions.length} questions with ${fallback.name}`);
          log.info(`📊 Generated ${processedQuestions.length} questions with ${fallback.name}`);
          return processedQuestions;
        } catch (error) {
          log.warn(`❌ Fallback provider ${fallback.name} failed:`, error.message);
          log.error(`❌ Fallback provider ${fallback.name} failed: ${error.message}`);
        }
      }
    }

    const errorMessage = 'All configured providers failed to generate questions';
    log.error(errorMessage);
    throw new Error(errorMessage);
  }

  /**
   * Test API key for a specific provider
   * @param {string} providerName - Name of the provider
   * @param {string} apiKey - API key to test
   * @returns {Promise<boolean>} True if API key is valid
   */
  async testApiKey(providerName, apiKey) {
    try {
      const provider = ProviderFactory.createProvider(providerName);
      await provider.configure(apiKey);
      return await provider.testApiKey();
    } catch (error) {
      log.error(`API key test failed for ${providerName}:`, error.message);
      return false;
    }
  }

  /**
   * Get information about all available providers
   * @returns {Array<Object>} Provider information
   */
  getAvailableProviders() {
    return ProviderFactory.getAllProviderInfo();
  }

  /**
   * Get information about the current provider
   * @returns {Object|null} Current provider information
   */
  getCurrentProviderInfo() {
    if (!this.currentProvider) {
      return null;
    }

    return {
      name: this.providerName,
      ...this.currentProvider.getProviderInfo(),
      fallbackCount: this.fallbackProviders.length
    };
  }

  /**
   * Build the prompt for question generation
   * @param {string} context - Content context
   * @param {Object} options - Generation options
   * @returns {string} Formatted prompt
   */
  buildPrompt(context, options) {
    const { questionCount, difficulty, questionTypes, includeMath } = options;

    const mathInstruction = includeMath
      ? "Use LaTeX notation for mathematical expressions. IMPORTANT: Use single backslashes for LaTeX commands in JSON (e.g., $x^2 + 3x - 5 = 0$ for inline math, $$\\\\\\\\int_0^1 x^2 dx$$ for display math, $90^\\circ$ for degrees)."
      : "Avoid complex mathematical notation.";

    const questionTypesList = questionTypes.map(type => {
      switch (type) {
        case 'multiple_choice': return 'multiple choice (4 options)';
        case 'true_false': return 'true/false';
        case 'short_answer': return 'short answer';
        case 'essay': return 'essay';
        default: return type;
      }
    }).join(', ');

    return `
Based on the following content, generate ${questionCount} high-quality ${difficulty} level questions.

Content:
${context}

Instructions:
- Create questions of these types: ${questionTypesList}
- Difficulty level: ${difficulty}
- ${mathInstruction}
- For multiple choice questions, provide exactly 4 options with only one correct answer
- For true/false questions, provide the correct answer (true or false)
- For short answer questions, provide a sample correct answer
- For essay questions, provide grading criteria

Return the response as a valid JSON object with this exact structure:
{
  "questions": [
    {
      "type": "multiple_choice",
      "text": "Question text here",
      "points": 2,
      "choices": [
        {"id": 0, "text": "Option A"},
        {"id": 1, "text": "Option B"},
        {"id": 2, "text": "Option C"},
        {"id": 3, "text": "Option D"}
      ],
      "correctAnswer": 1,
      "explanation": "Why this answer is correct"
    },
    {
      "type": "true_false",
      "text": "True/false question text",
      "points": 1,
      "correctAnswer": "true",
      "explanation": "Explanation"
    },
    {
      "type": "short_answer",
      "text": "Short answer question text",
      "points": 3,
      "sampleAnswer": "Sample correct answer",
      "explanation": "Explanation"
    },
    {
      "type": "essay",
      "text": "Essay question text",
      "points": 10,
      "gradingRubric": "Grading criteria",
      "explanation": "What students should address"
    }
  ]
}

Important: 
- Return ONLY the JSON object, no additional text or formatting
- Use single backslashes (\\) for LaTeX commands in JSON strings
- Ensure all JSON is properly escaped and valid
        `;
  }

  /**
   * Validate and process questions from any provider
   * @param {Array} questions - Raw questions from provider
   * @returns {Array} Processed questions
   */
  validateAndProcessQuestions(questions) {
    log.info(`Starting validation of ${questions.length} questions`);
    const processedQuestions = [];

    questions.forEach((question, index) => {
      try {
        log.info(`Processing question ${index + 1}:`, {
          type: question.type,
          text: question.text?.substring(0, 50) + '...',
          hasChoices: question.choices ? question.choices.length : 'N/A',
          correctAnswer: question.correctAnswer
        });

        const processedQuestion = {
          id: `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${index}`,
          type: question.type,
          text: question.text,
          points: question.points || 1
        };

        // Validate question type
        if (!['multiple_choice', 'true_false', 'short_answer', 'essay'].includes(question.type)) {
          log.warn(`Skipping question ${index + 1}: Invalid type ${question.type}`);
          return;
        }

        // Type-specific validation and processing
        if (question.type === 'multiple_choice') {
          if (!question.choices || !Array.isArray(question.choices) || question.choices.length !== 4) {
            log.warn(`Skipping question ${index + 1}: Multiple choice must have exactly 4 choices. Got:`, question.choices);
            return;
          }
          processedQuestion.choices = question.choices.map((choice, i) => ({
            id: i,
            text: choice.text
          }));
          processedQuestion.correctAnswer = question.correctAnswer;
          log.info(`Multiple choice question processed. Correct answer: ${question.correctAnswer}`);
        } else if (question.type === 'true_false') {
          if (!['true', 'false'].includes(question.correctAnswer)) {
            log.warn(`Skipping question ${index + 1}: True/false must have 'true' or 'false' as correct answer. Got: ${question.correctAnswer}`);
            return;
          }
          processedQuestion.correctAnswer = question.correctAnswer;
        } else if (question.type === 'short_answer') {
          processedQuestion.sampleAnswer = question.sampleAnswer || '';
        } else if (question.type === 'essay') {
          processedQuestion.gradingRubric = question.gradingRubric || '';
        }

        // Add explanation if provided
        if (question.explanation) {
          processedQuestion.explanation = question.explanation;
        }

        processedQuestions.push(processedQuestion);
        log.info(`Successfully processed question ${index + 1}`);
      } catch (error) {
        log.warn(`Error processing question ${index + 1}:`, error);
      }
    });

    log.info(`Validation complete. ${processedQuestions.length} questions processed successfully.`);

    if (processedQuestions.length === 0) {
      throw new Error('No valid questions were generated');
    }

    return processedQuestions;
  }

  /**
   * Extract text from PDF using the existing extractor
   * @param {Buffer} pdfBuffer - PDF buffer
   * @returns {Promise<string>} Extracted text
   */
  async extractTextFromPDF(pdfBuffer) {
    const PDFExtractor = require('./pdf-extractor');

    try {
      const extractor = new PDFExtractor();
      const text = await extractor.extractText(pdfBuffer);

      if (text && text.trim().length > 0) {
        return text;
      } else {
        throw new Error('No readable text found in PDF.');
      }

    } catch (error) {
      log.warn('PDF extraction failed:', error.message);
      throw new Error(error.message);
    }
  }

  /**
   * Get cached API key for a provider
   * @param {string} providerName - Provider name
   * @returns {string|null} Cached API key
   */
  getCachedApiKey(providerName) {
    return this.apiKeyCache.getApiKey(providerName);
  }

  /**
   * Remove cached API key for a provider
   * @param {string} providerName - Provider name
   */
  removeCachedApiKey(providerName) {
    this.apiKeyCache.removeApiKey(providerName);
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    return this.apiKeyCache.getStats();
  }

  /**
   * Clear all cached API keys
   */
  clearCache() {
    this.apiKeyCache.clear();
  }

  /**
   * Get configuration value
   * @param {string} path - Configuration path
   * @returns {*} Configuration value
   */
  getConfig(path) {
    return this.configManager.get(path);
  }

  /**
   * Set configuration value
   * @param {string} path - Configuration path
   * @param {*} value - Configuration value
   */
  setConfig(path, value) {
    this.configManager.set(path, value);
  }

  /**
   * Update service configuration
   * @param {Object} newConfig - New configuration options
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.currentProvider) {
      this.currentProvider.destroy();
    }

    this.fallbackProviders.forEach(fallback => {
      fallback.provider.destroy();
    });

    if (this.apiKeyCache) {
      this.apiKeyCache.destroy();
    }

    this.currentProvider = null;
    this.fallbackProviders = [];
  }
}

export default LLMService;
