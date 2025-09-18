import {NextRequest, NextResponse} from 'next/server';

export const dynamic = 'force-dynamic'; // defaults to auto

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({detail: 'No file uploaded.'}, {status: 400});
    }

    const backendUrl = 'http://147.93.102.137:8000/convert-ppt/';

    const backendResponse = await fetch(backendUrl, {
      method: 'POST',
      body: formData,
    });

    if (!backendResponse.ok) {
      const errorData = await backendResponse.text();
      // Try to parse as JSON, but fallback to text if it fails
      try {
        const jsonData = JSON.parse(errorData);
        return NextResponse.json(jsonData, {status: backendResponse.status});
      } catch (e) {
        return new NextResponse(errorData, {status: backendResponse.status});
      }
    }

    const data = await backendResponse.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    let errorMessage = 'An unknown error occurred in the proxy.';
    if (error instanceof Error) {
      errorMessage = error.message;
    }
    return NextResponse.json(
      {detail: errorMessage},
      {status: 500}
    );
  }
}
