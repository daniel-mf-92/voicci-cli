#!/usr/bin/env python3

import sys
import os
import json
import torch
from TTS.api import TTS
import re

class TTSEngine:
    def __init__(self, model_name="tts_models/multilingual/multi-dataset/xtts_v2", device=None):
        """Initialize TTS engine with XTTS v2 model"""

        # Auto-detect best device
        if device is None:
            if torch.backends.mps.is_available():
                self.device = "mps"  # Apple Silicon Metal
                print("Using Metal (MPS) acceleration", file=sys.stderr)
            elif torch.cuda.is_available():
                self.device = "cuda"
                print("Using CUDA acceleration", file=sys.stderr)
            else:
                self.device = "cpu"
                print("Using CPU (no acceleration)", file=sys.stderr)
        else:
            self.device = device

        print(f"Loading {model_name}...", file=sys.stderr)
        self.tts = TTS(model_name).to(self.device)
        print("Model loaded successfully", file=sys.stderr)

    def split_into_sentences(self, text):
        """Split text into sentences for better prosody"""
        # Basic sentence splitting
        sentences = re.split(r'(?<=[.!?])\s+', text)

        # Filter out empty sentences
        sentences = [s.strip() for s in sentences if s.strip()]

        return sentences

    def generate_chapter(self, chapter_data, output_dir, progress_callback=None):
        """Generate audio for a chapter"""

        chapter_num = chapter_data['number']
        chapter_title = chapter_data['title']
        chapter_text = chapter_data['text']

        # Create output directory if needed
        os.makedirs(output_dir, exist_ok=True)

        # Split into sentences
        sentences = self.split_into_sentences(chapter_text)
        total_sentences = len(sentences)

        print(f"Generating chapter {chapter_num}: {chapter_title}", file=sys.stderr)
        print(f"Total sentences: {total_sentences}", file=sys.stderr)

        # Generate audio file for entire chapter
        output_file = os.path.join(output_dir, f"chapter_{chapter_num:03d}.wav")

        # Join sentences with small pauses
        full_text = '. '.join(sentences)

        try:
            # Generate speech
            self.tts.tts_to_file(
                text=full_text,
                file_path=output_file,
                language="en"
            )

            print(f"Generated: {output_file}", file=sys.stderr)

            if progress_callback:
                progress_callback(chapter_num, total_sentences, total_sentences)

            return {
                'success': True,
                'output_file': output_file,
                'sentences': total_sentences
            }

        except Exception as e:
            print(f"Error generating chapter {chapter_num}: {str(e)}", file=sys.stderr)
            return {
                'success': False,
                'error': str(e)
            }

    def generate_audiobook(self, chapters_file, output_dir):
        """Generate audio for all chapters from JSON file"""

        # Load chapters
        with open(chapters_file, 'r') as f:
            chapters = json.load(f)

        print(f"Processing {len(chapters)} chapters", file=sys.stderr)

        results = []
        for i, chapter in enumerate(chapters):
            print(f"Chapter {i+1}/{len(chapters)}", file=sys.stderr)
            result = self.generate_chapter(chapter, output_dir)
            results.append(result)

        return results


def main():
    if len(sys.argv) < 3:
        print("Usage: tts-engine.py <chapters.json> <output_dir>", file=sys.stderr)
        sys.exit(1)

    chapters_file = sys.argv[1]
    output_dir = sys.argv[2]

    # Initialize engine
    engine = TTSEngine()

    # Generate audiobook
    results = engine.generate_audiobook(chapters_file, output_dir)

    # Output results as JSON
    print(json.dumps(results))


if __name__ == "__main__":
    main()
