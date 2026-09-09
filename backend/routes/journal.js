const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const Journal = require('../models/Journal');
const { extractTheoriesFromNarrative, summarizeText } = require('../services/summaryService');

// Extract IT theories from narrative (replaces /summarize)
router.post('/extract-theories', authenticateToken, async (req, res) => {
  try {
    const { narrative } = req.body;

    if (!narrative || narrative.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Narrative is required for theory extraction',
      });
    }

    console.log('[Journal Route] Processing theory extraction request');
    console.log('[Journal Route] Narrative length:', narrative.length);
    
    const identifiedTheories = await extractTheoriesFromNarrative(narrative);

    res.status(200).json({
      success: true,
      message: 'Theories extracted successfully',
      data: {
        identifiedTheories,
      },
    });
  } catch (error) {
    console.error('[Journal Route] Error extracting theories:', error);
    res.status(500).json({
      success: false,
      message: 'Error extracting theories',
      error: error.message,
    });
  }
});

// Legacy endpoint for backward compatibility
router.post('/summarize', authenticateToken, async (req, res) => {
  try {
    const { narrative, concepts = [] } = req.body;

    if (!narrative || narrative.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Narrative is required for summarization',
      });
    }

    console.log('[Journal Route] Processing (deprecated) summarization request');
    
    const summary = await summarizeText(narrative, 200, concepts);

    res.status(200).json({
      success: true,
      message: 'Summary generated successfully',
      data: {
        summary,
      },
    });
  } catch (error) {
    console.error('[Journal Route] Error generating summary:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating summary',
      error: error.message,
    });
  }
});

// Submit or save journal entry
router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const { week, dayCovered, narrative, identifiedTheories = [], photoDataUrl } = req.body;
    const studentId = req.user.id;

    if (!week || !narrative) {
      return res.status(400).json({
        success: false,
        message: 'Week and narrative are required',
      });
    }

    if (photoDataUrl && !photoDataUrl.startsWith('data:image/')) {
      return res.status(400).json({
        success: false,
        message: 'Photo must be an image data URL',
      });
    }

    if (photoDataUrl && photoDataUrl.length > 26_214_400) {
      return res.status(400).json({
        success: false,
        message: 'Photo is too large. Please upload an image under 25MB.',
      });
    }

    // Get student info to find supervisor
    const User = require('../models/User');
    const student = await User.findById(studentId).select('supervisorId');

    const journal = new Journal({
      studentId,
      supervisorId: student?.supervisorId || null,
      week,
      dayCovered: dayCovered || null,
      narrative,
      identifiedTheories: identifiedTheories || [],
      photoDataUrl: photoDataUrl || null,
      theoriesExtractedAt: new Date(),
      status: 'submitted',
    });

    await journal.save();

    res.status(201).json({
      success: true,
      message: 'Journal submitted successfully',
      data: journal,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error submitting journal',
      error: error.message,
    });
  }
});

// Get journals for a student
router.get('/my-journals', authenticateToken, async (req, res) => {
  try {
    const studentId = req.user.id;
    const journals = await Journal.find({ studentId }).sort({ submittedAt: -1 });

    res.status(200).json({
      success: true,
      data: journals,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching journals',
      error: error.message,
    });
  }
});

// Get a specific journal
router.get('/:journalId', authenticateToken, async (req, res) => {
  try {
    const User = require('../models/User');
    const journal = await Journal.findById(req.params.journalId).populate('studentId', 'fullName email supervisorId').populate('supervisorId', 'fullName email');

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    // Check authorization: student can view their own journal, supervisor can view journals from assigned trainees, or coordinator can view supervisor-signed journals
    const isStudent = journal.studentId._id.toString() === req.user.id;
    const isSupervisor = req.user.role === 'supervisor' && journal.studentId.supervisorId.toString() === req.user.id;
    const isCoordinator = req.user.role === 'coordinator' && journal.supervisorSigned === true;

    if (!isStudent && !isSupervisor && !isCoordinator) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to view this journal',
      });
    }

    res.status(200).json({
      success: true,
      data: journal,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching journal',
      error: error.message,
    });
  }
});

// Update journal
router.put('/:journalId', authenticateToken, async (req, res) => {
  try {
    const journal = await Journal.findById(req.params.journalId);

    if (!journal) {
      return res.status(404).json({
        success: false,
        message: 'Journal not found',
      });
    }

    if (journal.studentId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this journal',
      });
    }

    const { narrative, dayCovered, identifiedTheories, status, photoDataUrl } = req.body;

    if (narrative) journal.narrative = narrative;
    if (dayCovered) journal.dayCovered = dayCovered;
    if (identifiedTheories) {
      journal.identifiedTheories = identifiedTheories;
      journal.theoriesExtractedAt = new Date();
    }
    if (photoDataUrl) {
      if (!photoDataUrl.startsWith('data:image/')) {
        return res.status(400).json({
          success: false,
          message: 'Photo must be an image data URL',
        });
      }
      if (photoDataUrl.length > 26_214_400) {
        return res.status(400).json({
          success: false,
          message: 'Photo is too large. Please upload an image under 25MB.',
        });
      }
      journal.photoDataUrl = photoDataUrl;
    }
    if (status) journal.status = status;

    await journal.save();

    res.status(200).json({
      success: true,
      message: 'Journal updated successfully',
      data: journal,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error updating journal',
      error: error.message,
    });
  }
});

module.exports = router;
