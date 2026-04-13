/**
 * Background Image Compression Worker
 */
self.onmessage = async (e) => {
    const { file, maxWidth, quality } = e.data;

    try {
        self.postMessage({ type: 'progress', value: 10 });
        
        // Use createImageBitmap which is faster and available in workers
        const bitmap = await createImageBitmap(file);
        self.postMessage({ type: 'progress', value: 40 });
        
        let width = bitmap.width;
        let height = bitmap.height;

        if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
        }

        // Use OffscreenCanvas to prevent UI blocking
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        self.postMessage({ type: 'progress', value: 70 });

        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        self.postMessage({ type: 'progress', value: 100 });
        
        self.postMessage({ type: 'result', success: true, blob });
    } catch (error) {
        self.postMessage({ type: 'result', success: false, error: error.message });
    }
};