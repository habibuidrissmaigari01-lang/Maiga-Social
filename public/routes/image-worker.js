self.onmessage = async (e) => {
    const { file, maxWidth, quality } = e.data;

    try {
        // Use ImageBitmap for high-performance, low-memory decoding
        const bitmap = await createImageBitmap(file);
        
        let width = bitmap.width;
        let height = bitmap.height;

        // Calculate aspect ratio
        if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
        }

        // Use OffscreenCanvas for background thread rendering
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Draw and scale the image
        ctx.drawImage(bitmap, 0, 0, width, height);

        // Release the bitmap memory immediately after drawing
        bitmap.close();

        // Export to blob
        const blob = await canvas.convertToBlob({
            type: 'image/jpeg',
            quality: quality || 0.7
        });

        self.postMessage({
            type: 'result',
            success: true,
            blob: blob
        });

    } catch (error) {
        self.postMessage({
            type: 'result',
            success: false,
            error: error.message
        });
    }
};

// Helper for progress tracking (optional)
function reportProgress(value) {
    self.postMessage({ type: 'progress', value });
}